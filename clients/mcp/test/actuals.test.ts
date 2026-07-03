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
      // 0023c: the acceptance counts are measured, never model-writable — no
      // change-accounting field may appear on the estimate tool either.
      expect(serialized).not.toContain("produced");
      expect(serialized).not.toContain("accepted");
      expect(serialized).not.toContain("change");
      // `language` is a declared host signal resolved from the environment, not
      // a model-writable argument (the rule-5 hazard the hosted endpoint guards
      // against). It must never be an input property. (We don't scan the
      // serialized schema for the word: the human description legitimately reads
      // "natural-language description of the coding task".)
      expect(props).not.toContain("language");
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
      readUsage: () => ({ tokensIn: 12340, tokensOut: 36210, trace: [] }),
    });

    expect(code).toBe(0);
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.estimateId).toBe("est_auto");
    expect(sent.tokensIn).toBe(12340);
    expect(sent.tokensOut).toBe(36210);
    expect(sent.success).toBe(true);
    // An empty trace is never attached.
    expect(sent.trace).toBeUndefined();
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
      readUsage: () => null,
    });

    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries).toHaveLength(1);
  });

  it("forwards a measured trace and omits an over-cap one (still submits total)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_trace", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });

    // Within caps → trace is forwarded verbatim on the same POST.
    const okClient = makeFakeClient();
    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(okClient),
      readUsage: () => ({
        tokensIn: 100,
        tokensOut: 200,
        trace: [
          { tool: "Read", tokens: 50 },
          { tool: "Bash", tokens: 25, kind: "turn-split" },
          { tool: "Edit", tokens: 25, kind: "turn-split" },
        ],
      }),
    });
    const okSent = okClient.submitActuals.mock.calls[0]![0];
    expect(okSent.tokensIn).toBe(100);
    expect(okSent.trace).toEqual([
      { tool: "Read", tokens: 50 },
      { tool: "Bash", tokens: 25, kind: "turn-split" },
      { tool: "Edit", tokens: 25, kind: "turn-split" },
    ]);

    // Over the step cap → trace dropped, but the total is still submitted.
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_overcap", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });
    const overClient = makeFakeClient();
    const huge = Array.from({ length: 513 }, () => ({ tool: "Read", tokens: 1 }));
    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(overClient),
      readUsage: () => ({ tokensIn: 5, tokensOut: 7, trace: huge }),
    });
    const overSent = overClient.submitActuals.mock.calls[0]![0];
    expect(overSent.tokensIn).toBe(5);
    expect(overSent.tokensOut).toBe(7);
    expect(overSent.trace).toBeUndefined();
    expect(readPending(home).entries).toEqual([]);
  });

  it("threads the trace-target opt-out through to the usage reader", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_optout", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });

    // Opt-out env → reader asked to omit target.
    const offClient = makeFakeClient();
    let offOpts: { target?: boolean } | undefined;
    await runAutoActuals({
      payload: PAYLOAD,
      env: { ...ENV, BUDGETARY_TRACE_TARGET: "off" } as NodeJS.ProcessEnv,
      home,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(offClient),
      readUsage: (_p, opts) => {
        offOpts = opts;
        return { tokensIn: 1, tokensOut: 1, trace: [{ tool: "Bash", tokens: 2, ok: true }] };
      },
    });
    expect(offOpts).toEqual({ target: false });
    // ok survives the opt-out; total is still submitted.
    const offSent = offClient.submitActuals.mock.calls[0]![0];
    expect(offSent.trace).toEqual([{ tool: "Bash", tokens: 2, ok: true }]);

    // Default env → reader asked to include target.
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_opton", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });
    let onOpts: { target?: boolean } | undefined;
    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: (_p, opts) => {
        onOpts = opts;
        return { tokensIn: 1, tokensOut: 1, trace: [] };
      },
    });
    expect(onOpts).toEqual({ target: true });
  });

  it("forwards target + ok on the same POST when present", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_enriched", query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
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
      readUsage: () => ({
        tokensIn: 100,
        tokensOut: 49,
        trace: [{ tool: "Bash", tokens: 149, target: "pytest abc123def456", ok: false }],
      }),
    });
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.trace).toEqual([
      { tool: "Bash", tokens: 149, target: "pytest abc123def456", ok: false },
    ]);
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

// ---------------------------------------------------------------------------
// Change counts (0023c): two measured integers ride the SAME actuals POST.
// ---------------------------------------------------------------------------

describe("runAutoActuals — acceptance change counts", () => {
  const PAYLOAD = { transcript_path: "/tmp/transcript.jsonl", reason: "clear" };
  function pend(id: string) {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: id, query: "q", project_id: "p", created_at: RECENT, attempts: 0 },
      ],
    });
  }
  const run = (fake: FakeClient, env: NodeJS.ProcessEnv, changes: { produced: number; accepted: number }) =>
    runAutoActuals({
      payload: PAYLOAD,
      env,
      home,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 100, tokensOut: 200, trace: [], changes }),
    });

  it("forwards produced/accepted measured from the transcript", async () => {
    pend("est_changes");
    const fake = makeFakeClient();
    await run(fake, ENV, { produced: 5, accepted: 3 });
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.producedChanges).toBe(5);
    expect(sent.acceptedChanges).toBe(3);
    // The realized total is unaffected — it remains the contract.
    expect(sent.tokensIn).toBe(100);
    expect(sent.tokensOut).toBe(200);
  });

  it("forwards an honest { 0, 0 } for an edit-free run", async () => {
    pend("est_zero");
    const fake = makeFakeClient();
    await run(fake, ENV, { produced: 0, accepted: 0 });
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.producedChanges).toBe(0);
    expect(sent.acceptedChanges).toBe(0);
  });

  it("omits BOTH counts under the trace-detail opt-out; the total still submits", async () => {
    pend("est_optout_changes");
    const fake = makeFakeClient();
    await run(fake, { ...ENV, BUDGETARY_TRACE_TARGET: "off" } as NodeJS.ProcessEnv, {
      produced: 4,
      accepted: 2,
    });
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect("producedChanges" in sent).toBe(false);
    expect("acceptedChanges" in sent).toBe(false);
    expect(sent.tokensIn).toBe(100);
    expect(sent.tokensOut).toBe(200);
  });

  it("sends ONLY the two integers — no path, diff, or content on the acceptance signal", async () => {
    pend("est_only_ints");
    const fake = makeFakeClient();
    await run(fake, ENV, { produced: 3, accepted: 2 });
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(Number.isInteger(sent.producedChanges)).toBe(true);
    expect(Number.isInteger(sent.acceptedChanges)).toBe(true);
    // The acceptance signal is exactly two scalars — nothing structured rides along.
    const signal = JSON.stringify({
      produced_changes: sent.producedChanges,
      accepted_changes: sent.acceptedChanges,
    });
    expect(signal).toBe('{"produced_changes":3,"accepted_changes":2}');
    expect(signal).not.toMatch(/[/\\]/); // no path separators
    expect(sent.acceptedChanges).toBeLessThanOrEqual(sent.producedChanges);
  });
});
