import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BASE_URL,
  budgetaryDir,
  configFilePath,
  resolveConfig,
  resolveConfigStatus,
} from "../src/config.js";

const env = (v?: string): NodeJS.ProcessEnv =>
  (v === undefined ? {} : { BUDGETARY_API_KEY: v }) as NodeJS.ProcessEnv;

describe("config path helpers", () => {
  it("derive ~/.budgetary and its config.json from an explicit home", () => {
    expect(budgetaryDir("/home/u")).toBe(join("/home/u", ".budgetary"));
    expect(configFilePath("/home/u")).toBe(
      join("/home/u", ".budgetary", "config.json"),
    );
  });
});

describe("resolveConfigStatus — key resolution + failure taxonomy", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "budgetary-sdk-config-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const writeConfig = (obj: unknown): void => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "config.json"),
      typeof obj === "string" ? obj : JSON.stringify(obj),
      "utf8",
    );
  };

  it("resolves the env key first, trimmed, tagged source=env", () => {
    const status = resolveConfigStatus(env("  bg_test_env  "), home);
    expect(status).toEqual({
      kind: "ok",
      config: { apiKey: "bg_test_env", baseUrl: DEFAULT_BASE_URL, source: "env" },
    });
  });

  it("treats a whitespace-only env value as no key (falls through)", () => {
    // No config file present, so a blank env key lands on no-key.
    expect(resolveConfigStatus(env("   "), home)).toEqual({ kind: "no-key" });
  });

  it("returns no-key when nothing is configured anywhere", () => {
    expect(resolveConfigStatus(env(), home)).toEqual({ kind: "no-key" });
  });

  it("falls back to the config file, trimmed, tagged source=config", () => {
    writeConfig({ api_key: "  bg_live_file  " });
    expect(resolveConfigStatus(env(), home)).toEqual({
      kind: "ok",
      config: {
        apiKey: "bg_live_file",
        baseUrl: DEFAULT_BASE_URL,
        source: "config",
      },
    });
  });

  it("honors a base_url override in the config file", () => {
    writeConfig({ api_key: "bg_live_file", base_url: "https://example.test" });
    expect(resolveConfigStatus(env(), home)).toEqual({
      kind: "ok",
      config: {
        apiKey: "bg_live_file",
        baseUrl: "https://example.test",
        source: "config",
      },
    });
  });

  it("refuses an insecure config base_url and falls back to the https default", () => {
    // A tampered / http:// staging base_url must not send the key in cleartext:
    // it is dropped for the secure default rather than adopted.
    writeConfig({ api_key: "bg_live_file", base_url: "http://evil.example" });
    const status = resolveConfigStatus(env(), home);
    expect(status.kind).toBe("ok");
    if (status.kind === "ok") {
      expect(status.config.baseUrl).toBe(DEFAULT_BASE_URL);
    }
  });

  it("adopts a localhost http config base_url (local development)", () => {
    writeConfig({ api_key: "bg_live_file", base_url: "http://localhost:8787" });
    const status = resolveConfigStatus(env(), home);
    expect(status.kind).toBe("ok");
    if (status.kind === "ok") {
      expect(status.config.baseUrl).toBe("http://localhost:8787");
    }
  });

  it("prefers the env key over the config-file key", () => {
    writeConfig({ api_key: "bg_live_file" });
    const status = resolveConfigStatus(env("bg_test_env"), home);
    expect(status.kind).toBe("ok");
    if (status.kind === "ok") {
      expect(status.config.apiKey).toBe("bg_test_env");
      expect(status.config.source).toBe("env");
    }
  });

  it("distinguishes an unreadable (non-JSON) config file from no key", () => {
    writeConfig("{ not valid json");
    expect(resolveConfigStatus(env(), home)).toEqual({
      kind: "unreadable",
      path: configFilePath(home),
    });
  });

  it("treats a blank / non-string api_key in the file as no key", () => {
    writeConfig({ api_key: "   " });
    expect(resolveConfigStatus(env(), home)).toEqual({ kind: "no-key" });
    writeConfig({ api_key: 42 });
    expect(resolveConfigStatus(env(), home)).toEqual({ kind: "no-key" });
  });
});

describe("resolveConfig — null-wrapper over resolveConfigStatus", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "budgetary-sdk-config-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns the resolved config on ok", () => {
    expect(resolveConfig(env("bg_test_env"), home)).toEqual({
      apiKey: "bg_test_env",
      baseUrl: DEFAULT_BASE_URL,
      source: "env",
    });
  });

  it("collapses both no-key and unreadable to null", () => {
    expect(resolveConfig(env(), home)).toBeNull();
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(join(home, ".budgetary", "config.json"), "{ broken", "utf8");
    expect(resolveConfig(env(), home)).toBeNull();
  });
});
