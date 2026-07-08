// Ported from clients/claude-code/test/on_session_end.test.ts. Adapted for
// Codex's Stop payload: no `reason` field; success is inferred from
// `last_assistant_message` being a non-empty string.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  BudgetaryError,
  type ActualsResponse,
  type EstimateResponse,
  type LedgerPage,
} from "@budgetary/sdk";

import { runOnSessionEnd } from "../src/hooks/on_session_end.js";
import { projectIdFromCwd } from "../src/commands/estimate.js";
import type { PendingStoreFile } from "../src/store.js";

interface FakeClient {
  estimate: ReturnType<typeof vi.fn>;
  submitActuals: ReturnType<typeof vi.fn>;
  getLedger: ReturnType<typeof vi.fn>;
}

function makeFakeClient(
  actualsImpl?: () => Promise<ActualsResponse>,
): FakeClient {
  return {
    estimate: vi.fn(async (): Promise<EstimateResponse> => ({
      estimateId: "x",
      scenario: "confident",
      void: false,
      distribution: null,
      confidence: 0,
      model: "m",
      expiresAt: "",
    })),
    submitActuals: vi.fn(
      actualsImpl ?? (async () => ({ received: true, ledgerEntryId: "led" })),
    ),
    getLedger: vi.fn(
      async (): Promise<LedgerPage> => ({ entries: [], nextCursor: null }),
    ),
  };
}

function captureStream() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c) => chunks.push(Buffer.from(c)));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function writePending(home: string, file: PendingStoreFile) {
  mkdirSync(join(home, ".budgetary"), { recursive: true });
  writeFileSync(
    join(home, ".budgetary", "pending.json"),
    JSON.stringify(file),
    "utf8",
  );
}

function readPending(home: string): PendingStoreFile {
  return JSON.parse(
    readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
  );
}

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-codex-home-"));
  cwd = mkdtempSync(join(tmpdir(), "budgetary-codex-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const ENV = { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv;

const NOW = new Date("2026-05-27T10:14:00Z");
const RECENT = "2026-05-27T10:00:00Z"; // 14 minutes earlier
const STALE = "2026-05-25T10:00:00Z";  // ~48 hours earlier

const PAYLOAD = {
  session_id: "sess_1",
  turn_id: "turn_1",
  transcript_path: "/tmp/codex-rollout.jsonl",
  cwd: "/tmp",
  hook_event_name: "Stop",
  model: "claude-opus-4-7",
  permission_mode: "default",
  stop_hook_active: true,
  last_assistant_message: "Done.",
};

describe("runOnSessionEnd (Codex Stop hook)", () => {
  it("submits actuals for one pending entry and removes it", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_to_submit",
          query: "q",
          project_id: projectIdFromCwd(cwd),
          created_at: RECENT,
          attempts: 0,
        },
      ],
    });
    const fake = makeFakeClient();
    const stdout = captureStream();
    const stderr = captureStream();

    const exit = await runOnSessionEnd({
      payload: PAYLOAD,
      env: ENV,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => NOW,
      readTotals: () => ({ tokensIn: 12340, tokensOut: 36210 }),
    });

    expect(exit).toBe(0);
    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    const call = fake.submitActuals.mock.calls[0]![0];
    expect(call.estimateId).toBe("est_to_submit");
    expect(call.tokensIn).toBe(12340);
    expect(call.tokensOut).toBe(36210);
    expect(call.success).toBe(true);

    expect(readPending(home).entries).toEqual([]);
  });

  it("treats null last_assistant_message as success=false", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_crash",
          query: "q",
          project_id: projectIdFromCwd(cwd),
          created_at: RECENT,
          attempts: 0,
        },
      ],
    });
    const fake = makeFakeClient();
    const stdout = captureStream();
    const stderr = captureStream();

    await runOnSessionEnd({
      payload: { ...PAYLOAD, last_assistant_message: null },
      env: ENV,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => NOW,
      readTotals: () => ({ tokensIn: 1, tokensOut: 1 }),
    });

    const call = fake.submitActuals.mock.calls[0]![0];
    expect(call.success).toBe(false);
  });

  it("does nothing when there are no pending entries", async () => {
    const fake = makeFakeClient();
    const stdout = captureStream();
    const stderr = captureStream();

    const exit = await runOnSessionEnd({
      payload: PAYLOAD,
      env: ENV,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => NOW,
      readTotals: () => ({ tokensIn: 1, tokensOut: 1 }),
    });

    expect(exit).toBe(0);
    expect(fake.submitActuals).not.toHaveBeenCalled();
  });

  it("drops stale (>24h) entries silently without submitting", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_stale",
          query: "q",
          project_id: projectIdFromCwd(cwd),
          created_at: STALE,
          attempts: 0,
        },
      ],
    });
    const fake = makeFakeClient();
    const stdout = captureStream();
    const stderr = captureStream();

    await runOnSessionEnd({
      payload: PAYLOAD,
      env: ENV,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => NOW,
      readTotals: () => ({ tokensIn: 1, tokensOut: 1 }),
    });

    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries).toEqual([]);
    expect(stdout.text()).toBe("");
  });

  it("keeps the entry and increments attempts on SDK failure", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_retry",
          query: "q",
          project_id: projectIdFromCwd(cwd),
          created_at: RECENT,
          attempts: 1,
        },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({
        code: "internal_error",
        message: "boom",
        httpStatus: 500,
        requestId: "r",
      });
    });
    const stdout = captureStream();
    const stderr = captureStream();

    await runOnSessionEnd({
      payload: PAYLOAD,
      env: ENV,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => NOW,
      readTotals: () => ({ tokensIn: 1, tokensOut: 1 }),
    });

    const file = readPending(home);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]!.attempts).toBe(2);
    expect(stderr.text()).toBe("");
  });

  it("drops the entry and logs one warning after the 5th failed attempt", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_give_up",
          query: "q",
          project_id: projectIdFromCwd(cwd),
          created_at: RECENT,
          attempts: 4,
        },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({
        code: "internal_error",
        message: "still broken",
        httpStatus: 500,
        requestId: "r",
      });
    });
    const stdout = captureStream();
    const stderr = captureStream();

    await runOnSessionEnd({
      payload: PAYLOAD,
      env: ENV,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => NOW,
      readTotals: () => ({ tokensIn: 1, tokensOut: 1 }),
    });

    expect(readPending(home).entries).toEqual([]);
    const warning = stderr.text();
    expect(warning).toContain("giving up");
    expect(warning).toContain("est_give_up");
    expect(warning).toContain("5 attempts");
    expect(warning.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("does not submit when transcript yields no token totals", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_no_tokens",
          query: "q",
          project_id: projectIdFromCwd(cwd),
          created_at: RECENT,
          attempts: 0,
        },
      ],
    });
    const fake = makeFakeClient();
    const stdout = captureStream();
    const stderr = captureStream();

    await runOnSessionEnd({
      payload: PAYLOAD,
      env: ENV,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => NOW,
      readTotals: () => null,
    });

    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries).toHaveLength(1);
  });

  it("closes only THIS session's estimate even when another project's entry is newer", async () => {
    // The globally-newest entry belongs to a DIFFERENT project (another running
    // session). The old "close the last entry" behavior would mis-pair this
    // session's tokens onto it; binding by project_id must skip it.
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_mine",
          query: "q",
          project_id: projectIdFromCwd(cwd),
          created_at: RECENT,
          attempts: 0,
        },
        {
          estimate_id: "est_other",
          query: "q",
          project_id: "0000000other0000",
          created_at: RECENT,
          attempts: 0,
        },
      ],
    });
    const fake = makeFakeClient();
    const stdout = captureStream();
    const stderr = captureStream();

    await runOnSessionEnd({
      payload: PAYLOAD,
      env: ENV,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: () => fake as unknown as import("@budgetary/sdk").BudgetaryClient,
      home,
      now: () => NOW,
      readTotals: () => ({ tokensIn: 12340, tokensOut: 36210 }),
    });

    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    expect(fake.submitActuals.mock.calls[0]![0].estimateId).toBe("est_mine");
    // The other session's entry is left untouched for its own session.
    expect(readPending(home).entries.map((e) => e.estimate_id)).toEqual([
      "est_other",
    ]);
  });
});

describe("runOnSessionEnd — baseUrl threading", () => {
  it("constructs the SDK client with baseUrl from the resolved config", async () => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "config.json"),
      JSON.stringify({
        api_key: "bg_test_dummy",
        base_url: "https://my-staging.example",
      }),
      "utf8",
    );
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_baseurl",
          query: "q",
          project_id: projectIdFromCwd(cwd),
          created_at: RECENT,
          attempts: 0,
        },
      ],
    });
    const fake = makeFakeClient();
    const stdout = captureStream();
    const stderr = captureStream();
    let capturedOpts: import("@budgetary/sdk").BudgetaryClientOptions | null = null;

    await runOnSessionEnd({
      payload: PAYLOAD,
      env: {} as NodeJS.ProcessEnv, // force the config-file resolution path
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      clientFactory: (opts) => {
        capturedOpts = opts;
        return fake as unknown as import("@budgetary/sdk").BudgetaryClient;
      },
      home,
      now: () => NOW,
      readTotals: () => ({ tokensIn: 1, tokensOut: 1 }),
    });

    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.apiKey).toBe("bg_test_dummy");
    expect(capturedOpts!.baseUrl).toBe("https://my-staging.example");
  });
});

// Sanity: file path the suite assumes is also where the hook writes back.
describe("store path resolution", () => {
  it("uses ~/.budgetary/pending.json under the overridden home", () => {
    writePending(home, { version: 1, entries: [] });
    expect(existsSync(join(home, ".budgetary", "pending.json"))).toBe(true);
  });
});
