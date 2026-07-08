import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseOnSessionEndArgs, SERVER_VERSION } from "../src/server.js";

describe("SERVER_VERSION", () => {
  it("is derived from package.json, not a hard-coded 0.0.0", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).not.toBe("0.0.0");
  });
});

describe("parseOnSessionEndArgs", () => {
  it("parses --transcript <path> and defaults success=true", () => {
    expect(parseOnSessionEndArgs(["--transcript", "/tmp/r.jsonl"])).toEqual({
      transcript: "/tmp/r.jsonl",
      success: true,
      error: null,
    });
  });

  it("accepts --rollout as an alias and a bare positional path", () => {
    expect(parseOnSessionEndArgs(["--rollout", "/tmp/r.jsonl"]).transcript).toBe(
      "/tmp/r.jsonl",
    );
    expect(parseOnSessionEndArgs(["/tmp/r.jsonl"])).toEqual({
      transcript: "/tmp/r.jsonl",
      success: true,
      error: null,
    });
  });

  it("--failed sets success=false regardless of order", () => {
    expect(
      parseOnSessionEndArgs(["--failed", "--transcript", "/tmp/r.jsonl"]).success,
    ).toBe(false);
    expect(
      parseOnSessionEndArgs(["--transcript", "/tmp/r.jsonl", "--failed"]).success,
    ).toBe(false);
  });

  it("errors when --transcript has no value (never a silent hook fall-through)", () => {
    const r = parseOnSessionEndArgs(["--transcript"]);
    expect(r.transcript).toBeNull();
    expect(r.error).toMatch(/requires a file path/);
  });

  it("errors instead of swallowing a flag-shaped value (--transcript --failed)", () => {
    const r = parseOnSessionEndArgs(["--transcript", "--failed"]);
    // The intent to submit is not silently reinterpreted as a file named --failed.
    expect(r.transcript).toBeNull();
    expect(r.error).toMatch(/requires a file path/);
  });

  it("no args → hook path (no transcript, no error)", () => {
    expect(parseOnSessionEndArgs([])).toEqual({
      transcript: null,
      success: true,
      error: null,
    });
  });
});
