#!/usr/bin/env node
// Keep the pinned `@budgetary/mcp` version in the DISTRIBUTED plugin manifests —
// AND the two version fields in the MCP-registry manifest (clients/mcp/server.json)
// — in lockstep with clients/mcp/package.json.
//
// The Claude Code hook and the two `.mcp.json` files launch the runtime with
// `npx @budgetary/mcp`; left unpinned that resolves to `latest`, so one bad
// publish would be fleet-wide with the key in the process env. Pinning trades
// auto-update for blast-radius control (CI already pins its own npx tooling
// exactly). This script rewrites the pin to the exact current mcp version; it is
// run by `pnpm run version-packages` right after `changeset version` bumps the
// package, and a CI check (.github/workflows/ci.yml) fails the build on any drift.
//
// Pass `--check` to verify without writing (used by CI): exits non-zero if any
// manifest is not pinned to the current version.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const version = JSON.parse(
  readFileSync(join(root, "clients/mcp/package.json"), "utf8"),
).version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-mcp-pin: unexpected @budgetary/mcp version: ${version}`);
  process.exit(1);
}

const pin = `@budgetary/mcp@${version}`;
// Match `@budgetary/mcp`, optionally already tagged with ANY spec (`@1.2.3`,
// `@latest`, `@next`, …), only when it ends the package spec (followed by a
// quote, whitespace, or end-of-line). The `@[^"\s]*` (not `@[0-9]…`) is
// deliberate: a floating dist-tag like `@latest` is the very thing this guard
// must catch and re-pin, not silently pass. A longer NAME like
// `@budgetary/mcp-foo` is still never touched — after `@budgetary/mcp` the `-`
// is neither a spec (`@…`) nor a terminator, so the lookahead fails and there is
// no match.
const SPEC = /@budgetary\/mcp(?:@[^"\s]*)?(?=["\s]|$)/g;

const targets = [
  "clients/claude-code/hooks/hooks.json",
  "clients/claude-code/.mcp.json",
  "clients/codex/.mcp.json",
];

const drifted = [];
let changed = 0;
for (const rel of targets) {
  const path = join(root, rel);
  const before = readFileSync(path, "utf8");
  const after = before.replace(SPEC, pin);
  if (after !== before) {
    drifted.push(rel);
    if (!check) {
      writeFileSync(path, after);
      changed += 1;
    }
  }
}

// clients/mcp/server.json is the MCP-registry manifest. It carries the mcp
// version as TWO plain JSON fields (top-level `version` and `packages[0].version`)
// — not an `@budgetary/mcp@X` npx spec — and `changeset version` never touches
// them, so every "Version Packages" PR arrives with server.json one bump behind
// and CI's `server.json version matches package.json` check red until someone
// hand-commits the fix. Re-sync those two fields here (the ONLY two `"version":`
// keys in the file) so that CI check becomes a true tripwire, not recurring toil.
// Surgical string replace, NOT parse+re-stringify, so the file's formatting
// (inline `transport`/`remotes` objects) is preserved and the diff stays minimal.
const VERSION_FIELD = /("version":\s*)"[^"]*"/g;
const serverJsonRel = "clients/mcp/server.json";
{
  const path = join(root, serverJsonRel);
  const before = readFileSync(path, "utf8");
  const after = before.replace(VERSION_FIELD, `$1"${version}"`);
  if (after !== before) {
    drifted.push(serverJsonRel);
    if (!check) {
      writeFileSync(path, after);
      changed += 1;
    }
  }
}

if (check) {
  if (drifted.length > 0) {
    console.error(
      `sync-mcp-pin --check: these files are out of sync with @budgetary/mcp@${version}:\n  ` +
        drifted.join("\n  ") +
        "\nRun `node scripts/sync-mcp-pin.mjs` (or `pnpm run version-packages`).",
    );
    process.exit(1);
  }
  console.log(
    `sync-mcp-pin --check: all manifests + server.json match ${version}`,
  );
} else {
  console.log(
    `sync-mcp-pin: synced ${targets.length} manifest(s) + server.json to ${version} (${changed} changed)`,
  );
}
