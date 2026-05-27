import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type {
  ActualsResponse,
  EstimateResponse,
  LedgerPage,
} from "@budgetary/sdk";
import { BudgetaryError } from "@budgetary/sdk";

import { runEstimate } from "../src/commands/estimate.js";

interface FakeClient {
  estimate: ReturnType<typeof vi.fn>;
  submitActuals: ReturnType<typeof vi.fn>;
  getLedger: ReturnType<typeof vi.fn>;
}

function makeFakeClient(estimateImpl: (...args: unknown[]) => Promise<EstimateResponse>): FakeClient {
  return {
    estimate: vi.fn(estimateImpl),
    submitActuals: vi.fn(async (): Promise<ActualsResponse> => ({
      received: true,
      ledgerEntryId: "led_1",
    })),
    getLedger: vi.fn(async (): Promise<LedgerPage> => ({
      entries: [],
      nextCursor: null,
    })),
  };
}

function captureStream() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c) => chunks.push(Buffer.from(c)));
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
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

describe("runEstimate — happy path", () => {
  it("calls the SDK with the right context and writes a pending entry", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const fake = makeFakeClient(async () => happyEstimate());

    const exit = await runEstimate({
      query: "fix the flaky test",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => new Date("2026-05-27T10:14:00Z"),
    });

    expect(exit).toBe(0);
    expect(fake.estimate).toHaveBeenCalledTimes(1);
    const [query, opts] = fake.estimate.mock.calls[0]!;
    expect(query).toBe("fix the flaky test");
    expect(opts.context.host).toBe("claude-code");
    expect(typeof opts.context.projectId).toBe("string");
    expect(opts.context.projectId).toMatch(/^[0-9a-f]{16}$/);

    const out = stdout.text();
    expect(out).toContain("Estimated cost: 48,000 tokens");
    expect(out).toContain("Scenario: confident");
    expect(out).toContain("Pending estimate stored");

    const file = JSON.parse(
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    );
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].estimate_id).toBe("est_01ABC");
    expect(file.entries[0].attempts).toBe(0);
  });
});

describe("runEstimate — void", () => {
  it("renders the void message and does NOT write a pending entry", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const fake = makeFakeClient(async () => voidEstimate());

    const exit = await runEstimate({
      query: "???",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
    });

    expect(exit).toBe(0);
    expect(stdout.text()).toContain("cannot confidently estimate");
    expect(() =>
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    ).toThrow();
  });
});

describe("runEstimate — no API key", () => {
  it("prints the hint and does NOT call the SDK", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const fake = makeFakeClient(async () => happyEstimate());

    const exit = await runEstimate({
      query: "anything",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
    });

    expect(exit).toBe(0);
    expect(fake.estimate).not.toHaveBeenCalled();
    const out = stdout.text();
    expect(out).toContain("no API key is configured");
    expect(out).toContain("BUDGETARY_API_KEY");
    // Hint must never leak the env var's value (there is no value here).
    expect(out).not.toContain("bg_test_dummy");
  });
});

describe("runEstimate — SDK error", () => {
  it("renders message + request_id and does NOT append a pending entry", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({
        code: "invalid_request",
        message: "query too long",
        httpStatus: 400,
        requestId: "req_xyz",
      });
    });

    const exit = await runEstimate({
      query: "a".repeat(20),
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
    });

    expect(exit).toBe(1);
    const err = stderr.text();
    expect(err).toContain("query too long");
    expect(err).toContain("req_xyz");
    expect(() =>
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    ).toThrow();
  });
});

describe("runEstimate — config file fallback", () => {
  it("reads the key from ~/.budgetary/config.json when env is unset", async () => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "config.json"),
      JSON.stringify({ api_key: "bg_test_dummy" }),
      "utf8",
    );

    const stdout = captureStream();
    const stderr = captureStream();
    const fake = makeFakeClient(async () => happyEstimate());

    const exit = await runEstimate({
      query: "from config file",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
    });

    expect(exit).toBe(0);
    expect(fake.estimate).toHaveBeenCalled();
    // Make sure the API key never appears in our output.
    expect(stdout.text()).not.toContain("bg_test_dummy");
    expect(stderr.text()).not.toContain("bg_test_dummy");
  });
});
