import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configDiagnostics,
  DEFAULT_SOURCE,
  debugEnabled,
  looksLikeBudgetaryKey,
  resolveLanguage,
  resolveSource,
  sanitizeSource,
  traceTargetEnabled,
} from "../src/config.js";

const env = (v?: string): NodeJS.ProcessEnv =>
  (v === undefined ? {} : { BUDGETARY_TRACE_TARGET: v }) as NodeJS.ProcessEnv;

const debugEnv = (v?: string): NodeJS.ProcessEnv =>
  (v === undefined ? {} : { BUDGETARY_DEBUG: v }) as NodeJS.ProcessEnv;

describe("debugEnabled — session-end diagnostics (fail-safe OFF)", () => {
  it("defaults to OFF when unset or blank", () => {
    expect(debugEnabled(debugEnv())).toBe(false);
    expect(debugEnabled(debugEnv(""))).toBe(false);
    expect(debugEnabled(debugEnv("  "))).toBe(false);
  });

  it("is ON only for explicit affirmatives (case-insensitive, trimmed)", () => {
    for (const v of ["1", "true", "on", "yes", "ON", " Yes ", "TRUE"]) {
      expect(debugEnabled(debugEnv(v))).toBe(true);
    }
  });

  it("stays OFF for off-values AND any unrecognized value (never floods stderr)", () => {
    for (const v of ["0", "false", "off", "no", "2", "verbose", "debug", "onn"]) {
      expect(debugEnabled(debugEnv(v))).toBe(false);
    }
  });
});

describe("traceTargetEnabled — privacy opt-out (fail-safe ON)", () => {
  it("defaults to ON when unset", () => {
    expect(traceTargetEnabled(env())).toBe(true);
  });

  it("stays ON only for explicit affirmatives and the blank/unset default", () => {
    for (const v of ["1", "true", "on", "yes", "ON", " Yes ", ""]) {
      expect(traceTargetEnabled(env(v))).toBe(true);
    }
  });

  it("is OFF for off-values AND any unrecognized value (fail toward less disclosure)", () => {
    // A mistyped opt-out (`disabled`, `redacted`) must NOT silently keep sending.
    for (const v of [
      "0", "false", "off", "no", "OFF", " False ", "No",
      "disabled", "redacted", "garbage", "2", "onn",
    ]) {
      expect(traceTargetEnabled(env(v))).toBe(false);
    }
  });
});

describe("looksLikeBudgetaryKey — hook-path key-shape guard", () => {
  it("accepts real bg_live_/bg_test_ keys (permissive body)", () => {
    for (const k of [
      "bg_live_ABC123",
      "bg_test_dummy",
      "bg_live_a1-b2_c3.d4",
      `bg_test_${"x".repeat(48)}`,
    ]) {
      expect(looksLikeBudgetaryKey(k)).toBe(true);
    }
  });

  it("rejects a value that is not a recognizable key", () => {
    for (const k of [
      "",
      "garbage",
      "sk-ant-api03-XXX",
      "bg_prod_x", // not live/test
      "bg_live_", // empty body
      "bg_test_ with space",
      "BG_LIVE_X", // wrong case
    ]) {
      expect(looksLikeBudgetaryKey(k)).toBe(false);
    }
  });
});

describe("resolveSource — declared provenance tag, fail-open to the default", () => {
  const src = (v?: string): NodeJS.ProcessEnv =>
    (v === undefined ? {} : { BUDGETARY_SOURCE: v }) as NodeJS.ProcessEnv;

  it("defaults to mcp_client when unset", () => {
    expect(resolveSource(src())).toBe(DEFAULT_SOURCE);
    expect(DEFAULT_SOURCE).toBe("mcp_client");
  });

  it("reads and trims BUDGETARY_SOURCE from the environment", () => {
    expect(resolveSource(src("  swe-bench  "))).toBe("swe-bench");
  });

  it("forwards an OPAQUE tag — it validates shape, never meaning", () => {
    // The client knows no lane vocabulary: any well-formed tag passes through
    // untouched, so a new server-side lane needs no client release. There is
    // deliberately no allowlist here to extend.
    for (const tag of ["swe-bench", "a", "some.future_lane-v2", "x".repeat(64)]) {
      expect(resolveSource(src(tag))).toBe(tag);
    }
  });

  it("fails open to the default for every malformed value (never throws, never truncates)", () => {
    // `metadata` is 2 KB-capped server-side (a published 413), so an unbounded or
    // junk value must resolve to the default rather than reach the wire and turn
    // a real contribution into a rejected request. Note it DEFAULTS — it does not
    // truncate a too-long value into a plausible-looking tag.
    for (const bad of [
      "",
      "   ",
      "x".repeat(65), // one over the bound
      "x".repeat(5000),
      "swe bench", // space
      "swe/bench", // slash
      "swe{bench}",
      "swe\nbench",
      'swe"bench',
      "swe;bench",
      "émoji-ünicode",
    ]) {
      expect(resolveSource(src(bad))).toBe(DEFAULT_SOURCE);
    }
  });

  it("IGNORES a `source` in ~/.budgetary/config.json — the deliberate divergence from resolveLanguage", () => {
    // This is the whole reason resolveSource takes no `home`: a config file is
    // machine-wide and PERMANENT. Set a tag there for one benchmark run, forget
    // it, and every ordinary session on that machine is thereafter stamped with a
    // provenance that is a lie — undetectably, because the rows look well-formed.
    // An env var's lifetime is the process the harness launched; that is the
    // correct scope for a run-level tag. If someone ever adds a file fallback
    // "for symmetry with language", this test is what stops them.
    const home = mkdtempSync(join(tmpdir(), "budgetary-src-"));
    try {
      mkdirSync(join(home, ".budgetary"), { recursive: true });
      writeFileSync(
        join(home, ".budgetary", "config.json"),
        JSON.stringify({ api_key: "bg_test_dummy", source: "swe-bench" }),
        "utf8",
      );
      // With the env unset, the file's tag has no effect whatsoever.
      expect(resolveSource(src())).toBe(DEFAULT_SOURCE);
      // And it is unreachable BY CONSTRUCTION: unlike resolveLanguage, resolveSource
      // takes no `home` and never opens the config file. This is the assertion that
      // fails if someone later adds a file fallback "for symmetry with language".
      expect(resolveSource.toString()).not.toContain("configFilePath");
      expect(resolveSource.toString()).not.toContain("readFileSync");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("narrates a SET-but-rejected tag under BUDGETARY_DEBUG — without echoing the value", () => {
    // A typo'd tag in a harness would otherwise default SILENTLY and mislabel the
    // whole batch with no signal anywhere. This is the operator's only warning.
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((s: unknown) => (written.push(String(s)), true));
    try {
      expect(
        resolveSource({
          BUDGETARY_SOURCE: "swe bench; cat /etc/passwd",
          BUDGETARY_DEBUG: "1",
        } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_SOURCE);
      const out = written.join("");
      expect(out).toContain("ignoring BUDGETARY_SOURCE");
      // The SHAPE, never the value — it may be long, or hold something the
      // operator didn't mean to print into a log.
      expect(out).not.toContain("swe bench");
      expect(out).not.toContain("/etc/passwd");

      // Silent when the variable is simply absent (the ordinary case).
      written.length = 0;
      expect(resolveSource({ BUDGETARY_DEBUG: "1" } as NodeJS.ProcessEnv)).toBe(DEFAULT_SOURCE);
      expect(written.join("")).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("sanitizeSource re-validates a value off disk (a corrupt entry never reaches the wire)", () => {
    // The same rule the store's read-time re-check uses, so a hand-edited or
    // half-written `source` is held to exactly the bound an env value is.
    expect(sanitizeSource("swe-bench")).toBe("swe-bench");
    expect(sanitizeSource("  swe-bench ")).toBe("swe-bench");
    expect(sanitizeSource(undefined)).toBeNull();
    expect(sanitizeSource(123)).toBeNull();
    expect(sanitizeSource({})).toBeNull();
    expect(sanitizeSource("")).toBeNull();
    expect(sanitizeSource("x".repeat(65))).toBeNull();
    expect(sanitizeSource("not a tag")).toBeNull();
  });
});

describe("resolveLanguage — declared signal, fail-open by omission", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "budgetary-lang-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const writeConfig = (obj: unknown): void => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "config.json"),
      JSON.stringify(obj),
      "utf8",
    );
  };

  it("reads and trims BUDGETARY_LANGUAGE from the environment", () => {
    expect(
      resolveLanguage({ BUDGETARY_LANGUAGE: "  TypeScript  " } as NodeJS.ProcessEnv, home),
    ).toBe("TypeScript");
  });

  it("omits (undefined) when no signal exists — never guesses", () => {
    expect(resolveLanguage({} as NodeJS.ProcessEnv, home)).toBeUndefined();
  });

  it("treats a blank/whitespace env value as no signal (fail-open)", () => {
    expect(resolveLanguage({ BUDGETARY_LANGUAGE: "   " } as NodeJS.ProcessEnv, home))
      .toBeUndefined();
  });

  it("falls back to ~/.budgetary/config.json `language`", () => {
    writeConfig({ api_key: "bg_test_dummy", language: " Python " });
    expect(resolveLanguage({} as NodeJS.ProcessEnv, home)).toBe("Python");
  });

  it("prefers the env var over the config-file value", () => {
    writeConfig({ api_key: "bg_test_dummy", language: "Python" });
    expect(
      resolveLanguage({ BUDGETARY_LANGUAGE: "Go" } as NodeJS.ProcessEnv, home),
    ).toBe("Go");
  });

  it("falls through to the config file when the env var is set but blank", () => {
    writeConfig({ api_key: "bg_test_dummy", language: "Python" });
    expect(
      resolveLanguage({ BUDGETARY_LANGUAGE: "   " } as NodeJS.ProcessEnv, home),
    ).toBe("Python");
  });

  it("ignores a non-string / blank config value (fail-open)", () => {
    writeConfig({ api_key: "bg_test_dummy", language: 42 });
    expect(resolveLanguage({} as NodeJS.ProcessEnv, home)).toBeUndefined();
    writeConfig({ api_key: "bg_test_dummy", language: "   " });
    expect(resolveLanguage({} as NodeJS.ProcessEnv, home)).toBeUndefined();
  });

  it("never throws on a missing or malformed config file", () => {
    expect(resolveLanguage({} as NodeJS.ProcessEnv, home)).toBeUndefined();
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(join(home, ".budgetary", "config.json"), "{ not json", "utf8");
    expect(resolveLanguage({} as NodeJS.ProcessEnv, home)).toBeUndefined();
  });
});

describe("configDiagnostics — printable, secret-free config view (O-7)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "budgetary-diag-"));
    mkdirSync(join(home, ".budgetary"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const writeConfig = (obj: unknown): void => {
    writeFileSync(join(home, ".budgetary", "config.json"), JSON.stringify(obj), "utf8");
  };

  it("reports source=none with no key", () => {
    const d = configDiagnostics({} as NodeJS.ProcessEnv, home);
    expect(d).toEqual({ source: "none", baseUrl: null, keyPrefix: null, warnings: [] });
  });

  it("reports the env source, default base URL, and the key PREFIX (never the value)", () => {
    const d = configDiagnostics({ BUDGETARY_API_KEY: "bg_live_supersecret" } as NodeJS.ProcessEnv, home);
    expect(d.source).toBe("env");
    expect(d.keyPrefix).toBe("bg_live_");
    expect(d.baseUrl).toBe("https://api.budgetary.tools");
    expect(JSON.stringify(d)).not.toContain("supersecret");
  });

  it("warns when a non-HTTPS config base_url is refused (fell back to the default)", () => {
    writeConfig({ api_key: "bg_test_x", base_url: "http://staging:8080" });
    const d = configDiagnostics({} as NodeJS.ProcessEnv, home);
    expect(d.source).toBe("config");
    expect(d.baseUrl).toBe("https://api.budgetary.tools");
    expect(d.warnings.join(" ")).toMatch(/refused/);
    expect(d.warnings.join(" ")).toContain("http://staging:8080");
  });

  it("honors an https config base_url with no warning", () => {
    writeConfig({ api_key: "bg_test_x", base_url: "https://custom.example.com" });
    const d = configDiagnostics({} as NodeJS.ProcessEnv, home);
    expect(d.baseUrl).toBe("https://custom.example.com");
    expect(d.warnings).toEqual([]);
  });

  it("honors a localhost http base_url (allowed loopback) with no 'refused' warning", () => {
    // isBaseUrlAllowed permits http on a loopback host — it must NOT be flagged as
    // refused, and the resolved URL is the localhost one, not the prod default.
    writeConfig({ api_key: "bg_test_x", base_url: "http://localhost:8787" });
    const d = configDiagnostics({} as NodeJS.ProcessEnv, home);
    expect(d.baseUrl).toBe("http://localhost:8787");
    expect(d.warnings).toEqual([]);
  });

  it("warns that an env key shadows a config base_url", () => {
    writeConfig({ api_key: "bg_test_fromfile", base_url: "https://custom.example.com" });
    const d = configDiagnostics({ BUDGETARY_API_KEY: "bg_live_env" } as NodeJS.ProcessEnv, home);
    expect(d.source).toBe("env");
    expect(d.warnings.join(" ")).toMatch(/config\.json is not read/);
    expect(d.warnings.join(" ")).toContain("https://custom.example.com");
  });

  it("marks an unrecognized key shape", () => {
    const d = configDiagnostics({ BUDGETARY_API_KEY: "not-a-bg-key" } as NodeJS.ProcessEnv, home);
    expect(d.keyPrefix).toBe("unrecognized");
  });

  it("reports source=unreadable for a broken config file", () => {
    writeFileSync(join(home, ".budgetary", "config.json"), "{ not json", "utf8");
    expect(configDiagnostics({} as NodeJS.ProcessEnv, home).source).toBe("unreadable");
  });
});
