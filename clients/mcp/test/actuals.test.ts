import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActualsResponse,
  EstimateResponse,
  LedgerPage,
} from "@budgetary/sdk";
import { BudgetaryError } from "@budgetary/sdk";

import {
  runAutoActuals,
  runManualActuals,
  submitActuals,
  type ActualCounts,
} from "../src/actuals.js";
import { PendingStore, type PendingStoreFile } from "../src/store.js";
import { readTranscriptTotals } from "../src/transcript.js";
import { TOOLS, TOOL_NAME } from "../src/server.js";

interface FakeClient {
  estimate: ReturnType<typeof vi.fn>;
  submitActuals: ReturnType<typeof vi.fn>;
  getLedger: ReturnType<typeof vi.fn>;
}

function makeFakeClient(submitImpl?: () => Promise<ActualsResponse>): FakeClient {
  return {
    estimate: vi.fn(
      async (): Promise<EstimateResponse> => ({
        estimateId: "x",
        scenario: "confident",
        void: false,
        distribution: null,
        confidence: 0,
        model: "m",
        expiresAt: "",
      }),
    ),
    submitActuals: vi.fn(
      submitImpl ?? (async () => ({ received: true, ledgerEntryId: "led" })),
    ),
    getLedger: vi.fn(
      async (): Promise<LedgerPage> => ({ entries: [], nextCursor: null }),
    ),
  };
}

const asClient = (fake: FakeClient) =>
  fake as unknown as import("@budgetary/sdk").BudgetaryClient;

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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ENV = { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv;
const NOW = new Date("2026-05-27T10:14:00Z");
const RECENT = "2026-05-27T10:00:00Z";

// A scripted prompt that answers each question in order.
function scriptedPrompt(answers: string[]): (q: string) => Promise<string> {
  let i = 0;
  return async () => answers[i++] ?? "";
}

// ---------------------------------------------------------------------------
// Non-fabrication guard — the core safety invariant
// ---------------------------------------------------------------------------

describe("non-fabrication guard", () => {
  it("exposes exactly one model-invokable tool: estimate", () => {
    expect(TOOLS).toHaveLength(1);
    expect(TOOLS[0]!.name).toBe(TOOL_NAME);
    expect(TOOL_NAME).toBe("estimate");
  });

  it("no model-invokable tool accepts token counts or actuals fields", () => {
    for (const tool of TOOLS) {
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> })
          .properties ?? {},
      );
      // The estimate tool only takes a query and an optional model hint.
      expect(props.sort()).toEqual(["model", "query"]);
      const serialized = JSON.stringify(tool.inputSchema).toLowerCase();
      expect(serialized).not.toContain("token");
      expect(serialized).not.toContain("actual");
      expect(serialized).not.toContain("success");
      expect(serialized).not.toContain("duration");
    }
    // And there is no tool that writes actuals at all.
    expect(TOOLS.map((t) => t.name)).not.toContain("actual");
    expect(TOOLS.map((t) => t.name)).not.toContain("report-actual");
  });

  it("submitActuals only sends the counts its caller supplied", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_x", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });
    const store = new PendingStore({ path: join(home, ".budgetary", "pending.json") });
    const file = store.read();
    const fake = makeFakeClient();
    const counts: ActualCounts = {
      tokensIn: 100,
      tokensOut: 200,
      success: true,
      durationMs: 5,
    };

    await submitActuals({
      store,
      file,
      client: asClient(fake),
      entry: file.entries[0]!,
      counts,
    });

    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.tokensIn).toBe(100);
    expect(sent.tokensOut).toBe(200);
    expect(sent.success).toBe(true);
    expect(sent.durationMs).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Manual path (report-actual)
// ---------------------------------------------------------------------------

describe("runManualActuals", () => {
  it("submits human-entered counts and removes the entry on success", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_manual", query: "refactor the parser", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["12340", "36210", "y", "420000"]),
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(0);
    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.estimateId).toBe("est_manual");
    expect(sent.tokensIn).toBe(12340);
    expect(sent.tokensOut).toBe(36210);
    expect(sent.success).toBe(true);
    expect(sent.durationMs).toBe(420000);
    expect(readPending(home).entries).toEqual([]);
    expect(out.join("\n")).toContain("Actuals submitted");
  });

  it("rejects non-integer token counts without submitting", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_bad", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["not-a-number", "36210", "y", ""]),
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(2);
    expect(fake.submitActuals).not.toHaveBeenCalled();
    // Entry left untouched.
    expect(readPending(home).entries).toHaveLength(1);
    expect(out.join("\n")).toContain("non-negative whole number");
  });

  it("keeps the entry and increments attempts on a single submit failure", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_retry", query: "q", project_id: "p", created_at: RECENT, attempts: 1 },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "internal_error", message: "boom", httpStatus: 500, requestId: "r" });
    });
    const out: string[] = [];

    const code = await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["1", "2", "y", ""]),
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(1);
    const entries = readPending(home).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.attempts).toBe(2);
    expect(out.join("\n")).toContain("still pending");
  });

  it("drops the entry after the 5th failed attempt", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_give_up", query: "q", project_id: "p", created_at: RECENT, attempts: 4 },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "internal_error", message: "still broken", httpStatus: 500, requestId: "r" });
    });
    const out: string[] = [];

    const code = await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["1", "2", "n", ""]),
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(1);
    expect(readPending(home).entries).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain("giving up");
    expect(text).toContain("est_give_up");
    expect(text).toContain("5 attempts");
  });

  it("does nothing when there is no pending estimate", async () => {
    writePending(home, { version: 1, entries: [] });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["1", "2", "y", ""]),
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(0);
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("No pending");
  });
});

// ---------------------------------------------------------------------------
// Auto path (session-end hook), including cache_read exclusion
// ---------------------------------------------------------------------------

describe("runAutoActuals", () => {
  const PAYLOAD = {
    transcript_path: "/tmp/transcript.jsonl",
    reason: "clear",
  };

  it("submits real transcript counts and removes the entry", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_auto", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    const code = await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readTotals: () => ({ tokensIn: 12340, tokensOut: 36210 }),
    });

    expect(code).toBe(0);
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.estimateId).toBe("est_auto");
    expect(sent.tokensIn).toBe(12340);
    expect(sent.tokensOut).toBe(36210);
    expect(sent.success).toBe(true);
    expect(readPending(home).entries).toEqual([]);
  });

  it("submits nothing when the transcript yields no totals", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_none", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readTotals: () => null,
    });

    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries).toHaveLength(1);
  });

  it("excludes cache_read_input_tokens from the realized total", () => {
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          message: {
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 9_000_000,
              cache_creation_input_tokens: 2000,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const totals = readTranscriptTotals(transcript);
    expect(totals).toEqual({ tokensIn: 1000, tokensOut: 500 });
  });
});
