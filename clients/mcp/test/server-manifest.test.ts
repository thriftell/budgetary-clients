import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { contributionStatus, SESSION_END_ENV } from "../src/contribution.js";
import { DEFAULT_HOST } from "../src/tools/estimate.js";

/**
 * `server.json` is the MCP-registry manifest: the document a one-click install
 * derives its server config from. It is also a PUBLICATION — the registry
 * mirrors and caches it — so what it declares is held to the same invariants as
 * anything else that reaches a user, and to one more besides: an installer sets
 * whatever this file declares, so a declaration is a *capability the user can
 * hand themselves*. See {@link SESSION_END_ENV}.
 */
interface Manifest {
  version: string;
  packages: {
    identifier: string;
    version: string;
    environmentVariables?: {
      name: string;
      description?: string;
      isRequired?: boolean;
      isSecret?: boolean;
    }[];
  }[];
}

const manifestPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "server.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const declared = manifest.packages[0]!.environmentVariables ?? [];
const byName = new Map(declared.map((v) => [v.name, v]));

describe("server.json — the registry manifest", () => {
  it("declares the API key as required and secret", () => {
    const key = byName.get("BUDGETARY_API_KEY");
    expect(key).toBeDefined();
    expect(key!.isRequired).toBe(true);
    expect(key!.isSecret).toBe(true);
  });

  it("declares BUDGETARY_HOST as OPTIONAL and NON-SECRET", () => {
    // Optional because the server has an honest default and must never fail to
    // start without it; non-secret because it is a benign tag, and marking it
    // secret would have clients mask it in the very UI where someone has to
    // read what they typed.
    const host = byName.get("BUDGETARY_HOST");
    expect(host).toBeDefined();
    expect(host!.isRequired).toBe(false);
    expect(host!.isSecret).toBe(false);
  });

  it("names the value that unlocks the first-run notice", () => {
    // The declaration only helps if the installer's field says what to type.
    // `claude-code` is the one value the 0024d notice keys on, so a description
    // that stops naming it leaves a registry user with a blank box and no clue.
    expect(byName.get("BUDGETARY_HOST")!.description ?? "").toContain("claude-code");
  });

  it("NEVER declares the session-end hook discriminator", () => {
    // ★ The load-bearing one. `BUDGETARY_SESSION_END` is trustworthy precisely
    // because only an artifact we ship sets it (see contribution.ts). Declaring
    // it here would put it in an installer's form, letting anyone assert a hook
    // they have not wired — and a user who wrongly claims one is silently
    // classified as already contributing and never told otherwise. A manifest
    // may declare tags; it may never declare capabilities.
    expect(byName.has(SESSION_END_ENV)).toBe(false);
    expect(declared.map((v) => v.name)).not.toContain("BUDGETARY_SESSION_END");
  });

  it("nothing it declares is a contribution signal", () => {
    // The whole point of 0024f: declaring BUDGETARY_HOST changes what a host is
    // TOLD TO SET, never what the code TRUSTS. Build the env a registry install
    // produces — every declared variable, at every value that could plausibly be
    // typed — and assert the automatic-path verdict is unmoved.
    const home = mkdtempSync(join(tmpdir(), "budgetary-manifest-"));
    const candidates = ["claude-code", "cursor", "codex", "copilot", DEFAULT_HOST, ""];
    for (const value of candidates) {
      const env = Object.fromEntries(
        declared.map((v) => [v.name, v.isSecret === true ? "bg_test_x" : value]),
      ) as NodeJS.ProcessEnv;
      expect(contributionStatus(env, home)).toEqual({ kind: "manual-only" });
    }
  });
});
