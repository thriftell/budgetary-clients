import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BudgetaryAuthError,
  BudgetaryError,
  BudgetaryNetworkError,
  BudgetaryPermissionError,
  BudgetaryRateLimitError,
  type BudgetaryClient,
  type BudgetaryClientOptions,
  type LedgerPage,
} from "@budgetary/sdk";

import { runDoctor } from "../src/doctor.js";
import { writeBreadcrumb } from "../src/breadcrumb.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-doctor-"));
  mkdirSync(join(home, ".budgetary"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const NOW = new Date("2026-05-27T10:14:00Z");

function writeConfig(obj: Record<string, unknown>) {
  writeFileSync(join(home, ".budgetary", "config.json"), JSON.stringify(obj), "utf8");
}

/** A client whose getLedger resolves or rejects as scripted. */
function ledgerClient(impl: () => Promise<LedgerPage>): BudgetaryClient {
  return {
    estimate: vi.fn(),
    submitActuals: vi.fn(),
    getLedger: vi.fn(impl),
  } as unknown as BudgetaryClient;
}

async function doctor(
  env: NodeJS.ProcessEnv,
  client?: BudgetaryClient,
): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await runDoctor({
    env,
    home,
    now: () => NOW,
    out: (l) => lines.push(l),
    clientFactory: client ? () => client : undefined,
  });
  return { code, text: lines.join("\n") };
}

const okLedger = () =>
  ledgerClient(async () => ({ entries: [], nextCursor: null }));

describe("runDoctor — no key / unreadable config", () => {
  it("reports no key and skips connectivity (exit 1), never touching the network", async () => {
    const client = okLedger();
    const { code, text } = await doctor({}, client);
    expect(code).toBe(1);
    expect(text).toContain("(none configured)");
    expect(text).toContain("Connectivity: skipped");
    expect(client.getLedger).not.toHaveBeenCalled();
  });

  it("distinguishes an unreadable config file from no key", async () => {
    writeFileSync(join(home, ".budgetary", "config.json"), "{ not json", "utf8");
    const { code, text } = await doctor({});
    expect(code).toBe(1);
    expect(text).toContain("unreadable");
    expect(text).toContain("Connectivity: skipped");
  });
});

describe("runDoctor — key present, connectivity classified via the error taxonomy", () => {
  const ENV = { BUDGETARY_API_KEY: "bg_test_secretvalue" } as NodeJS.ProcessEnv;

  it("reports success and exits 0 on a 200", async () => {
    const { code, text } = await doctor(ENV, okLedger());
    expect(code).toBe(0);
    expect(text).toContain("Connectivity: ✓");
    expect(text).toContain("HTTP 200");
  });

  it("shows the key SOURCE + PREFIX but NEVER the key value", async () => {
    const { text } = await doctor(ENV, okLedger());
    expect(text).toContain("bg_test_… (source: env)");
    expect(text).not.toContain("bg_test_secretvalue");
    expect(text).toContain("Base URL:  https://api.budgetary.tools");
  });

  it("classifies a 401 as a rejected key (exit 1)", async () => {
    const client = ledgerClient(async () => {
      throw new BudgetaryAuthError({ code: "authentication_failed", message: "no", httpStatus: 401, requestId: "r" });
    });
    const { code, text } = await doctor(ENV, client);
    expect(code).toBe(1);
    expect(text).toContain("rejected (401)");
  });

  it("classifies a 403 as no active plan (exit 1)", async () => {
    const client = ledgerClient(async () => {
      throw new BudgetaryPermissionError({ code: "permission_denied", message: "no plan", httpStatus: 403, requestId: null });
    });
    const { code, text } = await doctor(ENV, client);
    expect(code).toBe(1);
    expect(text).toContain("no active plan (403)");
  });

  it("treats a 429 as a VALID key (rate limited, not a failure of the key; exit 1)", async () => {
    const client = ledgerClient(async () => {
      throw new BudgetaryRateLimitError({ code: "rate_limited", message: "slow down", httpStatus: 429, requestId: null, retryAfterSeconds: 5 });
    });
    const { code, text } = await doctor(ENV, client);
    expect(code).toBe(1);
    expect(text).toContain("rate limited (429)");
    expect(text).toContain("key IS valid");
  });

  it("classifies a network failure and NAMES the base URL", async () => {
    const client = ledgerClient(async () => {
      throw new BudgetaryNetworkError({ code: "network", message: "fetch failed" });
    });
    const { code, text } = await doctor(ENV, client);
    expect(code).toBe(1);
    expect(text).toContain("couldn't reach https://api.budgetary.tools");
  });

  it("surfaces a generic 4xx with its request_id (exit 1)", async () => {
    const client = ledgerClient(async () => {
      throw new BudgetaryError({ code: "invalid_request", message: "bad", httpStatus: 400, requestId: "req_99" });
    });
    const { code, text } = await doctor(ENV, client);
    expect(code).toBe(1);
    expect(text).toContain("req_99");
  });

  it("handles a non-Error thrown value (defensive fallback)", async () => {
    const client = ledgerClient(async () => {
      throw "plain string boom"; // eslint-disable-line no-throw-literal
    });
    const { code, text } = await doctor(ENV, client);
    expect(code).toBe(1);
    expect(text).toContain("plain string boom");
  });

  it("makes exactly ONE probe, with maxRetries: 0 (never sits through a retry ladder)", async () => {
    let opts: BudgetaryClientOptions | undefined;
    const client = okLedger();
    const lines: string[] = [];
    await runDoctor({
      env: ENV,
      home,
      now: () => NOW,
      out: (l) => lines.push(l),
      clientFactory: (o) => {
        opts = o;
        return client;
      },
    });
    expect(client.getLedger).toHaveBeenCalledTimes(1);
    expect(opts?.maxRetries).toBe(0);
    // The key VALUE is used to build the client but is not among the printed lines.
    expect(lines.join("\n")).not.toContain("bg_test_secretvalue");
  });
});

describe("runDoctor — config transparency (O-7)", () => {
  it("warns that a non-HTTPS config base_url was refused, and shows the resolved URL", async () => {
    writeConfig({ api_key: "bg_test_x", base_url: "http://staging.internal:8080" });
    const { text } = await doctor({}, okLedger());
    expect(text).toContain("Base URL:  https://api.budgetary.tools");
    expect(text).toContain("was refused");
    expect(text).toContain("http://staging.internal:8080");
  });

  it("warns that an env key shadows a config base_url", async () => {
    writeConfig({ api_key: "bg_test_fromfile", base_url: "https://custom.example.com" });
    const env = { BUDGETARY_API_KEY: "bg_live_env" } as NodeJS.ProcessEnv;
    const { text } = await doctor(env, okLedger());
    expect(text).toContain("config.json is not read");
    expect(text).toContain("https://custom.example.com");
  });

  it("emits no base_url warning when an https config base_url is honored", async () => {
    writeConfig({ api_key: "bg_test_x", base_url: "https://custom.example.com" });
    const { text } = await doctor({}, okLedger());
    expect(text).toContain("Base URL:  https://custom.example.com");
    expect(text).not.toContain("was refused");
    expect(text).not.toContain("is not read");
  });
});

describe("runDoctor — surfaces PR-1 local state", () => {
  it("shows the pending count and the last automatic-run breadcrumb", async () => {
    writeBreadcrumb(home, {
      startedAt: "2026-05-27T10:00:00Z",
      durationMs: 3,
      outcome: "submitted",
      estimateId: "est_led",
    });
    const { text } = await doctor({ BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv, okLedger());
    expect(text).toContain("Last auto: submitted est_led, 14m ago");
  });

  it("closes the loop on the breadcrumb line when it carries counts + band (T-1)", async () => {
    writeBreadcrumb(home, {
      startedAt: "2026-05-27T10:00:00Z",
      durationMs: 3,
      outcome: "submitted",
      estimateId: "est_led",
      tokensIn: 20000,
      tokensOut: 32000,
      forecastP10: 12500,
      forecastP50: 48000,
      forecastP90: 220000,
    });
    const { text } = await doctor({ BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv, okLedger());
    expect(text).toContain("actual 52,000 tokens vs forecast ~48,000 (within p10–p90)");
  });
});
