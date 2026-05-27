import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BASE_URL, resolveApiKey } from "../src/config.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-codex-config-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(contents: object) {
  mkdirSync(join(home, ".budgetary"), { recursive: true });
  writeFileSync(
    join(home, ".budgetary", "config.json"),
    JSON.stringify(contents),
    "utf8",
  );
}

describe("resolveApiKey — baseUrl parity (Codex)", () => {
  it("env-only path → baseUrl is the default", () => {
    const resolved = resolveApiKey({
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      home,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.apiKey).toBe("bg_test_dummy");
    expect(resolved!.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(resolved!.source).toBe("env");
  });

  it("config file with base_url → uses the custom value", () => {
    writeConfig({
      api_key: "bg_test_dummy",
      base_url: "https://my-staging.example",
    });
    const resolved = resolveApiKey({
      env: {} as NodeJS.ProcessEnv,
      home,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.baseUrl).toBe("https://my-staging.example");
    expect(resolved!.source).toBe("config_file");
  });

  it("config file without base_url → falls back to default", () => {
    writeConfig({ api_key: "bg_test_dummy" });
    const resolved = resolveApiKey({
      env: {} as NodeJS.ProcessEnv,
      home,
    });
    expect(resolved!.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("config file with empty/non-string base_url → falls back to default", () => {
    writeConfig({ api_key: "bg_test_dummy", base_url: "" });
    expect(
      resolveApiKey({ env: {} as NodeJS.ProcessEnv, home })!.baseUrl,
    ).toBe(DEFAULT_BASE_URL);

    writeConfig({ api_key: "bg_test_dummy", base_url: 42 });
    expect(
      resolveApiKey({ env: {} as NodeJS.ProcessEnv, home })!.baseUrl,
    ).toBe(DEFAULT_BASE_URL);

    writeConfig({ api_key: "bg_test_dummy", base_url: null });
    expect(
      resolveApiKey({ env: {} as NodeJS.ProcessEnv, home })!.baseUrl,
    ).toBe(DEFAULT_BASE_URL);
  });
});
