import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActualsResponse,
  EstimateResponse,
  LedgerPage,
} from "@budgetary/sdk";
import {
  BudgetaryAuthError,
  BudgetaryRateLimitError,
} from "@budgetary/sdk";

import { runEstimateTool } from "../src/tools/estimate.js";

interface FakeClient {
  estimate: ReturnType<typeof vi.fn>;
  submitActuals: ReturnType<typeof vi.fn>;
  getLedger: ReturnType<typeof vi.fn>;
}

function makeFakeClient(
  estimateImpl: (...args: unknown[]) => Promise<EstimateResponse>,
): FakeClient {
  return {
    estimate: vi.fn(estimateImpl),
    submitActuals: vi.fn(
      async (): Promise<ActualsResponse> => ({
        received: true,
        ledgerEntryId: "led_1",
      }),
    ),
    getLedger: vi.fn(
      async (): Promise<LedgerPage> => ({ entries: [], nextCursor: null }),
    ),
  };
}

function happyEstimate(): EstimateResponse {
  return {
    estimateId: "est_01ABC",
    scenario: "confident",
    void: false,
    distribution: { p10: 12500, p50: 48000, p90: 220000, unit: "tokens" },
    confidence: 0.74,
    model: "claude-opus-4-7",
    expiresAt: "2026-05-27T10:14:00Z",
  };
}

function voidEstimate(): EstimateResponse {
  return {
    estimateId: "est_void",
    scenario: "out_of_domain",
    void: true,
    distribution: null,
    confidence: 0,
    model: "claude-opus-4-7",
    expiresAt: "2026-05-27T10:14:00Z",
  };
}

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-home-"));
  cwd = mkdtempSync(join(tmpdir(), "budgetary-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const asClient = (fake: FakeClient) =>
  fake as unknown as import("@budgetary/sdk").BudgetaryClient;

describe("runEstimateTool — happy path", () => {
  it("threads host from BUDGETARY_HOST, passes query+model, appends pending, renders result", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    const result = await runEstimateTool({
      query: "fix the flaky test",
      model: "claude-sonnet-4-6",
      env: {
        BUDGETARY_API_KEY: "bg_test_dummy",
        BUDGETARY_HOST: "claude-code",
      } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
      now: () => new Date("2026-05-27T10:14:00Z"),
    });

    expect(result.isError).toBe(false);
    expect(fake.estimate).toHaveBeenCalledTimes(1);
    const [query, opts] = fake.estimate.mock.calls[0]!;
    expect(query).toBe("fix the flaky test");
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.context.host).toBe("claude-code");
    expect(opts.context.projectId).toMatch(/^[0-9a-f]{16}$/);

    expect(result.text).toContain("Estimated cost: 48,000 tokens");
    expect(result.text).toContain("p10–p90: 12,500–220,000");
    expect(result.text).toContain("Scenario: confident");
    expect(result.text).toContain("Pending estimate stored");
    // Never leak the key.
    expect(result.text).not.toContain("bg_test_dummy");

    const file = JSON.parse(
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    );
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].estimate_id).toBe("est_01ABC");
    expect(file.entries[0].attempts).toBe(0);
    expect(file.entries[0].query).toBe("fix the flaky test");
  });

  it("defaults host to \"mcp\" when BUDGETARY_HOST is unset", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    await runEstimateTool({
      query: "anything",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    const [, opts] = fake.estimate.mock.calls[0]!;
    expect(opts.context.host).toBe("mcp");
  });
});

describe("runEstimateTool — void", () => {
  it("renders the void message and does NOT write a pending entry", async () => {
    const fake = makeFakeClient(async () => voidEstimate());

    const result = await runEstimateTool({
      query: "???",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("cannot confidently estimate");
    expect(() =>
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    ).toThrow();
  });
});

describe("runEstimateTool — no API key", () => {
  it("returns configure-key guidance and does NOT call the SDK or throw", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    const result = await runEstimateTool({
      query: "anything",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(false);
    expect(fake.estimate).not.toHaveBeenCalled();
    expect(result.text).toContain("no API key");
    expect(result.text).toContain("BUDGETARY_API_KEY");
  });
});

describe("runEstimateTool — 403 subscription gate", () => {
  it("renders a subscription-required message, distinct from 401, not thrown", async () => {
    const fake = makeFakeClient(async () => {
      throw new BudgetaryAuthError({
        code: "permission_denied",
        message: "key lacks scope",
        httpStatus: 403,
        requestId: "req_403",
      });
    });

    const result = await runEstimateTool({
      query: "needs a plan",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("active plan");
    expect(result.text).toContain("https://budgetary.tools");
    // Must NOT be the 401 wording.
    expect(result.text).not.toContain("was rejected");
    // No pending entry on error.
    expect(() =>
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    ).toThrow();
  });
});

describe("runEstimateTool — 401 auth failure", () => {
  it("renders a key-rejected message distinct from the 403 wording", async () => {
    const fake = makeFakeClient(async () => {
      throw new BudgetaryAuthError({
        code: "authentication_failed",
        message: "bad key",
        httpStatus: 401,
        requestId: "req_401",
      });
    });

    const result = await runEstimateTool({
      query: "bad key",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("was rejected");
    expect(result.text).not.toContain("active plan");
  });
});

describe("runEstimateTool — 429 rate limit", () => {
  it("renders a retry-after message", async () => {
    const fake = makeFakeClient(async () => {
      throw new BudgetaryRateLimitError({
        code: "rate_limited",
        message: "slow down",
        httpStatus: 429,
        requestId: "req_429",
        retryAfterSeconds: 30,
      });
    });

    const result = await runEstimateTool({
      query: "too fast",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("rate limit");
    expect(result.text).toContain("30 seconds");
  });
});

describe("runEstimateTool — config file fallback", () => {
  it("reads the key from ~/.budgetary/config.json and never echoes it", async () => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "config.json"),
      JSON.stringify({ api_key: "bg_test_dummy" }),
      "utf8",
    );
    const fake = makeFakeClient(async () => happyEstimate());

    const result = await runEstimateTool({
      query: "from config file",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(fake.estimate).toHaveBeenCalled();
    expect(result.text).not.toContain("bg_test_dummy");
  });
});

describe("runEstimateTool — declared language forward", () => {
  it("forwards context.language from BUDGETARY_LANGUAGE (trimmed), beside host", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    await runEstimateTool({
      query: "build a feature",
      env: {
        BUDGETARY_API_KEY: "bg_test_dummy",
        BUDGETARY_HOST: "claude-code",
        BUDGETARY_LANGUAGE: "  TypeScript  ",
      } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    const [, opts] = fake.estimate.mock.calls[0]!;
    expect(opts.context.host).toBe("claude-code");
    expect(opts.context.language).toBe("TypeScript");
  });

  it("OMITS context.language entirely when no signal exists (server stores '(none)')", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    await runEstimateTool({
      query: "anything",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    const [, opts] = fake.estimate.mock.calls[0]!;
    // Omitted, not null/empty — the field must be absent from the body.
    expect("language" in opts.context).toBe(false);
  });

  it("reads context.language from ~/.budgetary/config.json when env is unset", async () => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "config.json"),
      JSON.stringify({ api_key: "bg_test_dummy", language: "Python" }),
      "utf8",
    );
    const fake = makeFakeClient(async () => happyEstimate());

    await runEstimateTool({
      query: "from config file",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    const [, opts] = fake.estimate.mock.calls[0]!;
    expect(opts.context.language).toBe("Python");
  });
});
