import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveLanguage, traceTargetEnabled } from "../src/config.js";

const env = (v?: string): NodeJS.ProcessEnv =>
  (v === undefined ? {} : { BUDGETARY_TRACE_TARGET: v }) as NodeJS.ProcessEnv;

describe("traceTargetEnabled — privacy opt-out (fail-safe ON)", () => {
  it("defaults to ON when unset", () => {
    expect(traceTargetEnabled(env())).toBe(true);
  });

  it("treats only explicit off-values as opt-out", () => {
    for (const v of ["0", "false", "off", "no", "OFF", " False ", "No"]) {
      expect(traceTargetEnabled(env(v))).toBe(false);
    }
  });

  it("leaves any other value ON (fail-safe — never silently suppresses)", () => {
    for (const v of ["1", "true", "on", "yes", "", "redacted", "garbage"]) {
      expect(traceTargetEnabled(env(v))).toBe(true);
    }
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
