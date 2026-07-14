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
  runPendingList,
  runRolloutActuals,
  submitActuals,
  type ActualCounts,
  type PendingWriter,
} from "../src/actuals.js";
import { PendingStore, type PendingEntry, type PendingStoreFile } from "../src/store.js";
import { projectIdFromCwd, runEstimateTool } from "../src/tools/estimate.js";
import { readTranscriptTotals } from "../src/transcript.js";
import * as transcriptModule from "../src/transcript.js";
import { readBreadcrumb, writeBreadcrumb } from "../src/breadcrumb.js";
import { runOnSessionEndCli, TOOLS, TOOL_NAME } from "../src/server.js";

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
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-home-"));
  cwd = mkdtempSync(join(tmpdir(), "budgetary-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
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
      // `language` is a declared host signal resolved from the environment, not
      // a model-writable argument (the rule-5 hazard the hosted endpoint guards
      // against). It must never be an input property. (We don't scan the
      // serialized schema for the word: the human description legitimately reads
      // "natural-language description of the coding task".)
      expect(props).not.toContain("language");
      // `source` is the same class of signal: a provenance tag DECLARED in the
      // environment (BUDGETARY_SOURCE) and resolved once, at estimate time. A
      // model that could name its own provenance could label a run as anything;
      // it must never become a tool argument either.
      expect(props).not.toContain("source");
    }
    // And there is no tool that writes actuals at all.
    expect(TOOLS.map((t) => t.name)).not.toContain("actual");
    expect(TOOLS.map((t) => t.name)).not.toContain("report-actual");
  });

  // This test's job is to stop a MODEL-FABRICATED field from reaching the wire:
  // every measured value must come from the caller, never from anything the model
  // could influence. The provenance tag added in 0024b is deliberately NOT such a
  // field, and the assertions below say why rather than simply allowing it: it is
  // a constant, environment-DECLARED tag, resolved once at estimate time and read
  // back off the pending ENTRY — there is no code path by which a model can set,
  // reach, or alter it. So the guard is: counts come from the caller, `source`
  // comes from the entry, and NOTHING else is on the request.
  it("submitActuals sends only the caller's counts + the entry's declared source (never a model-supplied field)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_x", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
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
      client: asClient(fake),
      entry: file.entries[0]!,
      counts,
    });

    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.tokensIn).toBe(100);
    expect(sent.tokensOut).toBe(200);
    expect(sent.success).toBe(true);
    expect(sent.durationMs).toBe(5);
    // The declared tag — from the entry (here: absent → the default constant).
    expect(sent.metadata).toEqual({ source: "mcp_client" });
    // And nothing else. A new field on this request must be a deliberate change
    // to this list, not something that slipped in.
    expect(Object.keys(sent).sort()).toEqual([
      "durationMs",
      "estimateId",
      "metadata",
      "success",
      "tokensIn",
      "tokensOut",
    ]);
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
        { estimate_id: "est_manual", query: "refactor the parser", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
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
    // The confirmation names the estimate id (O-4), not just "Actuals submitted".
    expect(out.join("\n")).toContain("Actuals submitted (est_manual).");
  });

  it("appends a forecast check when the entry carried a band (T-1)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_mband", query: "q", project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT, attempts: 0,
          forecast_p10: 100, forecast_p50: 500, forecast_p90: 2000,
        },
      ],
    });
    const out: string[] = [];
    await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["300", "180", "y", "9"]),
      clientFactory: () => asClient(makeFakeClient()),
    });
    expect(out.join("\n")).toContain(
      "Forecast check: actual 480 tokens vs forecast ~500 (within p10–p90)",
    );
  });

  it("--estimate-id closes a specific already-billed estimate with NO pending row (B-1)", async () => {
    // Empty store — the estimate was billed but never stored. --estimate-id must
    // still submit it (bound to the id alone) for free, no pending row required.
    writePending(home, { version: 1, entries: [] });
    const fake = makeFakeClient();
    const out: string[] = [];
    const code = await runManualActuals({
      env: ENV,
      home,
      estimateId: "est_short",
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["1000", "2000", "y", "500"]),
      clientFactory: () => asClient(fake),
    });
    expect(code).toBe(0);
    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    expect(fake.submitActuals.mock.calls[0]![0].estimateId).toBe("est_short");
    expect(out.join("\n")).toContain("Reporting actuals for estimate est_short:");
    expect(out.join("\n")).toContain("Actuals submitted (est_short).");
  });

  it("--estimate-id on a transport failure tells the user to re-run (not 'still pending')", async () => {
    writePending(home, { version: 1, entries: [] });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "unavailable", message: "down", httpStatus: 503, requestId: null });
    });
    const out: string[] = [];
    const code = await runManualActuals({
      env: ENV,
      home,
      estimateId: "est_short",
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["1000", "2000", "y", "500"]),
      clientFactory: () => asClient(fake),
    });
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("report-actual --estimate-id est_short");
    // A by-id submit isn't in the store, so it must NOT claim "still pending".
    expect(text).not.toContain("still pending");
  });

  it("--estimate-id on a TERMINAL 4xx says it can't succeed (not a key/plan retry loop)", async () => {
    // The synthetic by-id entry is never in the store, so submitActuals can't
    // reach its terminal-drop branch — a 409/404 must still be reported as
    // terminal, NOT mis-blamed on the key/plan with a futile re-run.
    writePending(home, { version: 1, entries: [] });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "idempotency_conflict", message: "already recorded", httpStatus: 409, requestId: null });
    });
    const out: string[] = [];
    const code = await runManualActuals({
      env: ENV,
      home,
      estimateId: "est_short",
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["1000", "2000", "y", "500"]),
      clientFactory: () => asClient(fake),
    });
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("It can't succeed, so nothing was recorded.");
    expect(text).not.toContain("Fix your API key or plan");
    expect(text).not.toContain("re-run");
  });

  it("--estimate-id on a user-fixable 403 points at the key/plan + a re-run", async () => {
    writePending(home, { version: 1, entries: [] });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "permission_denied", message: "no plan", httpStatus: 403, requestId: null });
    });
    const out: string[] = [];
    await runManualActuals({
      env: ENV,
      home,
      estimateId: "est_short",
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["1000", "2000", "y", "500"]),
      clientFactory: () => asClient(fake),
    });
    const text = out.join("\n");
    expect(text).toContain("Fix your API key or plan");
    expect(text).toContain("report-actual --estimate-id est_short");
  });

  it("rejects non-integer token counts (after re-prompting) without submitting", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_bad", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      // Three invalid answers exhaust the re-prompt retries.
      prompt: scriptedPrompt(["nope", "still-bad", "x"]),
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(2);
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries).toHaveLength(1);
    expect(out.join("\n")).toContain("non-negative whole number");
  });

  it("accepts comma-grouped numbers like 48,000", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_commas", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["48,000", "12,500", "y", "420,000"]),
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(0);
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.tokensIn).toBe(48000);
    expect(sent.tokensOut).toBe(12500);
    expect(sent.durationMs).toBe(420000);
  });

  it("rejects malformed grouping (1,2,3) rather than coercing it to 123", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_mal", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runManualActuals({
      env: ENV,
      home,
      out: (l) => out.push(l),
      // "1,2,3" is not a well-formed grouped number; three of them exhaust retries.
      prompt: scriptedPrompt(["1,2,3", "1,2,3", "1,2,3"]),
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(2);
    expect(fake.submitActuals).not.toHaveBeenCalled();
  });

  it("checks the API key BEFORE prompting for counts", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_nokey", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];
    let prompted = false;

    const code = await runManualActuals({
      env: {} as NodeJS.ProcessEnv, // no key anywhere
      home,
      out: (l) => out.push(l),
      prompt: async () => {
        prompted = true;
        return "1";
      },
      clientFactory: () => asClient(fake),
    });

    expect(code).toBe(1);
    expect(prompted).toBe(false); // never asked for counts
    expect(out.join("\n")).toContain("no API key");
    expect(fake.submitActuals).not.toHaveBeenCalled();
  });

  it("scopes to THIS project's estimate when a cwd is given", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_mine", query: "mine", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
        { estimate_id: "est_other", query: "other", project_id: "0000000other0000", created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    await runManualActuals({
      env: ENV,
      home,
      cwd,
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["1", "2", "y", ""]),
      clientFactory: () => asClient(fake),
    });

    // The globally-newest is est_other, but project binding closes est_mine.
    expect(fake.submitActuals.mock.calls[0]![0].estimateId).toBe("est_mine");
    expect(readPending(home).entries.map((e) => e.estimate_id)).toEqual(["est_other"]);
  });

  it("keeps the entry on a user-fixable rejection (403), advising a fix not a retry", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_403", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "permission_denied", message: "no active plan", httpStatus: 403, requestId: "r" });
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
    const text = out.join("\n");
    expect(text).toContain("rejected");
    expect(text.toLowerCase()).not.toContain("try again");
    expect(text).toContain("Fix your");
    // Fixing the plan lets the same submit succeed — the entry survives, unbumped.
    const entries = readPending(home).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.attempts).toBe(0);
  });

  it("discards the entry on a terminal rejection (400/404) so the queue can drain", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_gone", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "not_found", message: "estimate not found", httpStatus: 404, requestId: "r" });
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
    const text = out.join("\n");
    expect(text).toContain("discarded");
    expect(text.toLowerCase()).not.toContain("try again");
    // A terminal rejection must not pin the queue — the entry is dropped.
    expect(readPending(home).entries).toEqual([]);
  });

  it("keeps the entry and increments attempts on a single submit failure", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_retry", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 1 },
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
        { estimate_id: "est_give_up", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 4 },
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

describe("runPendingList", () => {
  it("reports an empty queue honestly (never claims 'the loop is closed')", () => {
    writePending(home, { version: 1, entries: [] });
    const out: string[] = [];
    const code = runPendingList({ env: ENV, home, out: (l) => out.push(l) });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("No pending Budgetary estimates awaiting actuals.");
    // Some estimates may have been DROPPED (gave-up/rejected/swept), so we must
    // not imply everything closed successfully.
    expect(text).not.toContain("loop is closed");
  });

  it("lists pending estimates and marks the ones for this project", () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_mine", query: "refactor the parser", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
        { estimate_id: "est_other", query: "another project task", project_id: "0000000other0000", created_at: RECENT, attempts: 0 },
      ],
    });
    const out: string[] = [];
    const code = runPendingList({ env: ENV, home, cwd, now: () => NOW, out: (l) => out.push(l) });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("2 pending Budgetary estimates");
    expect(text).toContain("refactor the parser");
    expect(text).toContain("(this project)");
    expect(text).toContain("report-actual");
  });

  it("enriches each row: attempts, measured flag, expiry, and the short id (O-3/O-4)", () => {
    writePending(home, {
      version: 1,
      entries: [
        // A retry entry: measured counts persisted after a prior failed submit.
        {
          estimate_id: "est_measured", query: "q", project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT, attempts: 2,
          tokens_in: 1000, tokens_out: 500, success: true, duration_ms: 42,
        },
        // A fresh entry: no persisted counts.
        { estimate_id: "est_fresh", query: "q2", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const out: string[] = [];
    runPendingList({ env: ENV, home, cwd, now: () => NOW, out: (l) => out.push(l) });
    const text = out.join("\n");
    // The measured (retry) row shows attempts, the measured flag, expiry, and id.
    expect(text).toMatch(/est_measured.*/);
    expect(text).toContain("2/5 attempts");
    expect(text).toContain("measured ✓");
    expect(text).toContain("id est_measured");
    // RECENT is 14m before NOW → ~24h left in the 24h window (rounded).
    expect(text).toContain("expires in ~24h");
    // The fresh row shows attempts + id but NOT "measured" (no counts on disk).
    const freshLine = out.find((l) => l.includes("id est_fresh"))!;
    expect(freshLine).toContain("0/5 attempts");
    expect(freshLine).not.toContain("measured");
  });

  it("says the auto-window passed for an aged entry (manual report still works)", () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_old", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: "2026-05-25T00:00:00Z", attempts: 1 },
      ],
    });
    const out: string[] = [];
    runPendingList({ env: ENV, home, cwd, now: () => NOW, out: (l) => out.push(l) });
    const text = out.join("\n");
    expect(text).toContain("auto-window passed");
    expect(text).toContain("manual report still works");
  });

  it("shows minutes when <1h remains in the window, and 'expiry unknown' for a bad timestamp", () => {
    // created_at 30m into the 24h window's tail → ~30m remaining (minutes branch).
    // NOW is 10:14 on the 27th; 24h earlier is 10:14 on the 26th, so a created_at
    // of 10:44 on the 26th leaves ~30m before the window closes.
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_soon", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: "2026-05-26T10:44:00Z", attempts: 0 },
        { estimate_id: "est_badts", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: "not-a-date", attempts: 0 },
      ],
    });
    const out: string[] = [];
    runPendingList({ env: ENV, home, cwd, now: () => NOW, out: (l) => out.push(l) });
    const soon = out.find((l) => l.includes("id est_soon"))!;
    expect(soon).toContain("expires in ~30m");
    const bad = out.find((l) => l.includes("id est_badts"))!;
    expect(bad).toContain("expiry unknown");
  });
});

// ---------------------------------------------------------------------------
// Rollout path (on-session-end --transcript): the working Codex actuals path.
// Reads REAL counts from a transcript file, reports loudly, binds by project.
// ---------------------------------------------------------------------------

describe("runRolloutActuals", () => {
  it("submits real transcript counts for THIS project and reports success", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_rollout", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runRolloutActuals({
      transcriptPath: "/tmp/rollout.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 629974, tokensOut: 28055, trace: [] }),
    });

    expect(code).toBe(0);
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.estimateId).toBe("est_rollout");
    expect(sent.tokensIn).toBe(629974);
    expect(sent.tokensOut).toBe(28055);
    expect(sent.success).toBe(true);
    // A Codex rollout carries no per-tool trace; nothing is fabricated.
    expect(sent.trace).toBeUndefined();
    expect(readPending(home).entries).toEqual([]);
    // The confirmation names the estimate id (O-4).
    expect(out.join("\n")).toContain("Actuals submitted (est_rollout):");
  });

  it("appends a forecast check when the pending entry carried a band (T-1)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_rband", query: "q", project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT, attempts: 0,
          forecast_p10: 100000, forecast_p50: 600000, forecast_p90: 900000,
        },
      ],
    });
    const out: string[] = [];
    await runRolloutActuals({
      transcriptPath: "/tmp/rollout.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => ({ tokensIn: 629974, tokensOut: 28055, trace: [] }),
    });
    // total 658,029 → within the 100k–900k band, forecast midpoint ~600,000.
    expect(out.join("\n")).toContain(
      "Forecast check: actual 658,029 tokens vs forecast ~600,000 (within p10–p90)",
    );
  });

  it("records success=false when --failed is passed", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_failed", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    await runRolloutActuals({
      transcriptPath: "/tmp/r.jsonl",
      success: false,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: () => {},
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 1, tokensOut: 1, trace: [] }),
    });

    expect(fake.submitActuals.mock.calls[0]![0].success).toBe(false);
  });

  it("binds to THIS project even when another project's entry is newer", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_mine", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
        { estimate_id: "est_other", query: "q", project_id: "0000000other0000", created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    await runRolloutActuals({
      transcriptPath: "/tmp/r.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: () => {},
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
    });

    expect(fake.submitActuals.mock.calls[0]![0].estimateId).toBe("est_mine");
    expect(readPending(home).entries.map((e) => e.estimate_id)).toEqual([
      "est_other",
    ]);
  });

  it("submits nothing and says so when the transcript yields no totals", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_none", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runRolloutActuals({
      transcriptPath: "/tmp/empty.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(fake),
      readUsage: () => null,
    });

    expect(code).toBe(1);
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries).toHaveLength(1);
    expect(out.join("\n")).toContain("No token totals");
  });

  it("checks the API key before reading the transcript", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_nokey", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];
    let readCalled = false;

    const code = await runRolloutActuals({
      transcriptPath: "/tmp/r.jsonl",
      success: true,
      env: {} as NodeJS.ProcessEnv, // no key anywhere (config-file path, no file)
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(fake),
      readUsage: () => {
        readCalled = true;
        return { tokensIn: 1, tokensOut: 1, trace: [] };
      },
    });

    expect(code).toBe(1);
    expect(readCalled).toBe(false); // key checked first — no wasted transcript read
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("no API key");
  });

  it("does nothing when there is no pending estimate for this project", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_other", query: "q", project_id: "0000000other0000", created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const out: string[] = [];

    const code = await runRolloutActuals({
      transcriptPath: "/tmp/r.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 1, tokensOut: 1, trace: [] }),
    });

    expect(code).toBe(0);
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("this project");
  });

  it("does NOT advise retry when the server rejects with a non-retryable 4xx", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_4xx", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({
        code: "invalid_request",
        message: "estimate_id already finalized",
        httpStatus: 400,
        requestId: "r",
      });
    });
    const out: string[] = [];

    const code = await runRolloutActuals({
      transcriptPath: "/tmp/r.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
    });

    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("rejected");
    // The core posture: never advise retrying a request the server rejected.
    expect(text.toLowerCase()).not.toContain("try again");
    expect(text).not.toContain("Actuals submitted");
  });

  it("reports a retryable transport failure as still-pending (not a rejection)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_5xx", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
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
    const out: string[] = [];

    const code = await runRolloutActuals({
      transcriptPath: "/tmp/r.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
    });

    expect(code).toBe(1);
    expect(out.join("\n")).toContain("still pending");
    expect(out.join("\n")).not.toContain("Actuals submitted");
  });
});

describe("submitActuals — outcome", () => {
  function oneEntryStore(): { store: PendingStore; entry: import("../src/store.js").PendingEntry } {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_o", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const store = new PendingStore({ path: join(home, ".budgetary", "pending.json") });
    return { store, entry: store.read().entries[0]! };
  }
  const counts: ActualCounts = { tokensIn: 1, tokensOut: 1, success: true, durationMs: 0 };

  it("returns submitted on success", async () => {
    const { store, entry } = oneEntryStore();
    const outcome = await submitActuals({ store, client: asClient(makeFakeClient()), entry, counts });
    expect(outcome).toMatchObject({ submitted: true, retryable: false, gaveUp: false });
  });

  it("returns terminal:true and drops the entry for a terminal 4xx (400/404)", async () => {
    const { store, entry } = oneEntryStore();
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "invalid_request", message: "bad", httpStatus: 400, requestId: "r" });
    });
    const outcome = await submitActuals({ store, client: asClient(fake), entry, counts });
    expect(outcome.submitted).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(outcome.terminal).toBe(true);
    expect(store.read().entries).toEqual([]); // dropped so it can't block the queue
  });

  it("keeps the entry (terminal:false) for a user-fixable 401/403", async () => {
    const { store, entry } = oneEntryStore();
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "authentication_failed", message: "bad key", httpStatus: 401, requestId: "r" });
    });
    const outcome = await submitActuals({ store, client: asClient(fake), entry, counts });
    expect(outcome.submitted).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(outcome.terminal).toBe(false);
    expect(store.read().entries).toHaveLength(1); // kept for the user to fix + resubmit
  });

  it("returns retryable:true for a 5xx", async () => {
    const { store, entry } = oneEntryStore();
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "internal_error", message: "boom", httpStatus: 500, requestId: "r" });
    });
    const outcome = await submitActuals({ store, client: asClient(fake), entry, counts });
    expect(outcome.retryable).toBe(true);
  });

  it("reports submitted:false (no false success) when the entry was closed mid-flight", async () => {
    const { store, entry } = oneEntryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = makeFakeClient(async () => {
      await gate;
      throw new BudgetaryError({ code: "internal_error", message: "boom", httpStatus: 500, requestId: "r" });
    });
    const submitting = submitActuals({ store, client: asClient(fake), entry, counts });
    // Another path closes the entry mid-flight (e.g. a concurrent success).
    const other = new PendingStore({ path: join(home, ".budgetary", "pending.json") });
    other.write({ version: 1, entries: [] });
    release();
    const outcome = await submitting;
    // The entry is gone, but THIS call did not submit — do not claim success.
    expect(outcome.submitted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store write faults must degrade, never crash (P-A2). `store.write` rethrows
// on any fs failure (an immutable / perm-lost ~/.budgetary, ENOSPC); a submit
// that has already committed to an outcome must report it honestly rather than
// throw a raw stack — most critically the auto hook, which fails closed.
// ---------------------------------------------------------------------------

describe("submitActuals — store.write faults degrade (never crash the caller)", () => {
  function makeEntry(id: string): PendingEntry {
    return { estimate_id: id, query: "q", project_id: "p", created_at: RECENT, attempts: 0 };
  }
  // A store whose read works but whose every write throws.
  function faultingStore(entries: PendingEntry[]) {
    const state: PendingStoreFile = { version: 1, entries };
    let writeAttempts = 0;
    const store: PendingWriter = {
      read: () => JSON.parse(JSON.stringify(state)) as PendingStoreFile,
      write: () => {
        writeAttempts += 1;
        throw new Error("EPERM: operation not permitted");
      },
    };
    return { store, attempts: () => writeAttempts };
  }

  it("post-success remove faults → still submitted:true (never reclassified retryable)", async () => {
    const entry = makeEntry("est_wok");
    const { store, attempts } = faultingStore([entry]);
    const warns: string[] = [];
    const outcome = await submitActuals({
      store,
      client: asClient(makeFakeClient()),
      entry,
      counts: { tokensIn: 1, tokensOut: 1, success: true, durationMs: 0 },
      logger: { warn: (m) => warns.push(m) },
    });
    // The POST won — a failed remove must NOT turn a committed submit retryable.
    expect(outcome.submitted).toBe(true);
    expect(outcome.retryable).toBe(false);
    expect(attempts()).toBe(1); // it did attempt to persist the removal
    expect(warns.some((w) => w.includes("could not update the pending store"))).toBe(true);
  });

  it("attempts-bump write fault on a 5xx → retryable outcome, no throw", async () => {
    const entry = makeEntry("est_wbump");
    const { store } = faultingStore([entry]);
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "internal_error", message: "boom", httpStatus: 500, requestId: "r" });
    });
    const warns: string[] = [];
    const outcome = await submitActuals({
      store,
      client: asClient(fake),
      entry,
      counts: { tokensIn: 1, tokensOut: 1, success: true, durationMs: 0 },
      logger: { warn: (m) => warns.push(m) },
    });
    expect(outcome.submitted).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(warns.some((w) => w.includes("could not update the pending store"))).toBe(true);
  });

  it("terminal-4xx drop write fault → terminal outcome, no throw", async () => {
    const entry = makeEntry("est_wdrop");
    const { store } = faultingStore([entry]);
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "invalid_request", message: "bad", httpStatus: 400, requestId: "r" });
    });
    const outcome = await submitActuals({
      store,
      client: asClient(fake),
      entry,
      counts: { tokensIn: 1, tokensOut: 1, success: true, durationMs: 0 },
      logger: { warn: () => {} },
    });
    expect(outcome.submitted).toBe(false);
    expect(outcome.terminal).toBe(true);
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
        { estimate_id: "est_auto", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    const code = await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
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

  it("records an honest trace-drop when the trace exceeds the cap (totals still submit)", async () => {
    // The longest, highest-spend sessions trip the trace cap. Dropping it whole
    // (a trimmed trace would misstate composition) must NOT read as a tool-free
    // run: the drop is recorded in the breadcrumb and, under debug, on stderr.
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_bigtrace", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    // 600 steps > TRACE_MAX_STEPS (512) → capTrace drops it.
    const bigTrace = Array.from({ length: 600 }, (_, i) => ({ tool: "Bash", tokens: i }));
    const errs: string[] = [];

    const code = await runAutoActuals({
      payload: PAYLOAD,
      env: { ...ENV, BUDGETARY_DEBUG: "1" },
      home,
      cwd,
      now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 100, tokensOut: 200, trace: bigTrace }),
    });

    expect(code).toBe(0);
    // Totals still submitted, with NO trace attached (fail-closed).
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.tokensIn).toBe(100);
    expect(sent.trace).toBeUndefined();
    // The drop is visible on stderr (debug) …
    expect(errs.join("")).toContain("trace over cap: 600 steps");
    // … and durably in the breadcrumb (read by `pending`/`doctor`).
    const crumb = readBreadcrumb(home);
    expect(crumb?.note).toContain("trace over cap: 600 steps");
    expect(crumb?.outcome).toBe("submitted");
  });

  it("warns (does not silently drop) when the server terminally rejects an auto actual", async () => {
    // INV-2: a terminal 4xx drops the entry to drain the queue, but this silent
    // hook path must leave a signal rather than lose a measured actual quietly.
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_4xx", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({
        code: "not_found",
        message: "estimate_id not visible to this key",
        httpStatus: 404,
        requestId: "r",
      });
    });
    const errs: string[] = [];

    const code = await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
    });

    expect(code).toBe(0);
    // The entry is dropped (queue-drain)...
    expect(readPending(home).entries).toEqual([]);
    // ...but NOT silently — the rejection is surfaced on stderr.
    const text = errs.join("");
    expect(text).toContain("rejected actuals for est_4xx");
    expect(text).toContain("dropped");
  });

  it("closes only THIS session's estimate even when another project's entry is newer", async () => {
    // The globally-newest entry belongs to a DIFFERENT project (another running
    // session); binding by project_id must skip it, not mis-pair this session's
    // tokens onto it.
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_mine", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
        { estimate_id: "est_other", query: "q", project_id: "0000000other0000", created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 12340, tokensOut: 36210, trace: [] }),
    });

    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    expect(fake.submitActuals.mock.calls[0]![0].estimateId).toBe("est_mine");
    expect(readPending(home).entries.map((e) => e.estimate_id)).toEqual([
      "est_other",
    ]);
  });

  it("submits nothing when the transcript yields no totals", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_none", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => null,
    });

    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries).toHaveLength(1);
  });

  it("skips submission (and keeps the entry) when the key isn't a recognizable bg_ key", async () => {
    // The hook path's key arrives via a shell-interpolated command; a garbage or
    // mis-substituted value must not be sent. The measured actual is left pending.
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_badkey", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const errs: string[] = [];

    const code = await runAutoActuals({
      payload: PAYLOAD,
      env: { BUDGETARY_API_KEY: "garbage-not-a-bg-key" } as NodeJS.ProcessEnv,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
    });

    expect(code).toBe(0);
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries).toHaveLength(1);
    expect(errs.join("")).toContain("bg_live_/bg_test_");
  });

  it("forwards a measured trace and omits an over-cap one (still submits total)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_trace", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });

    // Within caps → trace is forwarded verbatim on the same POST.
    const okClient = makeFakeClient();
    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
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
        { estimate_id: "est_overcap", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const overClient = makeFakeClient();
    const huge = Array.from({ length: 513 }, () => ({ tool: "Read", tokens: 1 }));
    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
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
        { estimate_id: "est_optout", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });

    // Opt-out env → reader asked to omit target.
    const offClient = makeFakeClient();
    let offOpts: { target?: boolean } | undefined;
    await runAutoActuals({
      payload: PAYLOAD,
      env: { ...ENV, BUDGETARY_TRACE_TARGET: "off" } as NodeJS.ProcessEnv,
      home,
      cwd,
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
        { estimate_id: "est_opton", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    let onOpts: { target?: boolean } | undefined;
    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
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
        { estimate_id: "est_enriched", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    await runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
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
// Cross-session actual pairing (P-B1). The auto path must never attach a LATER
// session's transcript to an OLDER estimate. Two guards: (1) a failed submit
// persists its OWN measured counts so a later retry resubmits those, never a new
// transcript; (2) a fresh submit is bound to the session (started_at) so a
// stale entry isn't paired with foreign usage.
// ---------------------------------------------------------------------------

describe("runAutoActuals — cross-session retry never mis-pairs (P-B1)", () => {
  const SESSION_START = "2026-05-27T09:14:00Z"; // NOW − 1h
  const BEFORE_SESSION = "2026-05-27T08:14:00Z"; // NOW − 2h (prior session, within TTL)

  // Part 1: an entry that carries persisted counts from a prior FAILED submit is
  // retried with THOSE counts — never the injected (different-session) usage.
  it("resubmits an entry's PERSISTED counts, never the running session's transcript", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_A",
          query: "q",
          project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT,
          attempts: 1,
          // Persisted by est_A's own (failed) submit in a PRIOR session:
          tokens_in: 111,
          tokens_out: 222,
          success: true,
          duration_ms: 5000,
          has_trace: false,
        },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      // A DIFFERENT session's usage — must NEVER be submitted under est_A.
      readUsage: () => ({ tokensIn: 999999, tokensOut: 888888, trace: [] }),
    });

    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.estimateId).toBe("est_A");
    expect(sent.tokensIn).toBe(111); // PERSISTED counts …
    expect(sent.tokensOut).toBe(222);
    expect(sent.tokensIn).not.toBe(999999); // … NOT the injected session's
    // Retry sends totals only; the original trace was not persisted.
    expect(sent.trace).toBeUndefined();
    expect(readPending(home).entries).toEqual([]); // closed on success
  });

  // Part 1 (the persistence half): a failed submit stamps its counts on the kept
  // entry so the NEXT session's run picks them up.
  it("persists measured counts onto the entry when a submit fails (retryable)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_fail", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "internal_error", message: "boom", httpStatus: 500, requestId: "r" });
    });

    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 4242, tokensOut: 1717, trace: [] }),
    });

    const entry = readPending(home).entries[0]! as unknown as Record<string, unknown>;
    expect(entry.attempts).toBe(1);
    expect(entry.tokens_in).toBe(4242);
    expect(entry.tokens_out).toBe(1717);
    expect(entry.success).toBe(true);
    expect(typeof entry.duration_ms).toBe("number");
  });

  // Part 2: with a session boundary (started_at), a fresh entry that predates the
  // session is NOT closed with this session's usage — submit nothing.
  it("submits NOTHING for a fresh entry that predates the session (started_at bind)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        // Fresh (no persisted counts), created BEFORE this session began.
        { estimate_id: "est_prior", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: BEFORE_SESSION, attempts: 1 },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear", started_at: SESSION_START },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 999999, tokensOut: 888888, trace: [] }),
    });

    // Not ours + no persisted counts → nothing submitted, entry left for retry/TTL.
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries.map((e) => e.estimate_id)).toEqual(["est_prior"]);
  });

  // Part 2 happy side: a fresh entry created DURING the session still submits.
  it("submits a fresh entry created during the session (started_at satisfied)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_now", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear", started_at: SESSION_START },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 500, tokensOut: 250, trace: [] }),
    });

    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.estimateId).toBe("est_now");
    expect(sent.tokensIn).toBe(500);
  });

  // A v1 file (no persisted-count fields) loads and takes the fresh path.
  it("treats a v1 entry with no persisted counts as fresh", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_v1", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 77, tokensOut: 33, trace: [] }),
    });

    const sent = fake.submitActuals.mock.calls[0]![0];
    expect(sent.tokensIn).toBe(77); // fresh transcript counts
  });

  // Corrupt persisted counts (e.g. a partial write) are ignored → fresh path,
  // never submitted as a fabricated number.
  it("ignores corrupt persisted counts and falls back to the fresh path", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_corrupt",
          query: "q",
          project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT,
          attempts: 1,
          // A partial/garbage write: tokens_in is a string, not a number.
          tokens_in: "garbage" as unknown as number,
          tokens_out: 222,
          success: true,
          duration_ms: 5000,
        },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 55, tokensOut: 66, trace: [] }),
    });

    const sent = fake.submitActuals.mock.calls[0]![0];
    // Fresh path used (corrupt persisted counts ignored), never "garbage".
    expect(sent.tokensIn).toBe(55);
    expect(sent.tokensOut).toBe(66);
  });
});

// ---------------------------------------------------------------------------
// TTL sweep (P-A4/B2/T1): expired entries from ALL projects are dropped (not
// just the one this session would close), with a single honest warning; an
// unparseable/future created_at has an unknown age and is never discarded.
// ---------------------------------------------------------------------------

describe("runAutoActuals — TTL sweep", () => {
  const EXPIRED = "2026-05-25T09:00:00Z"; // > 24h before NOW (2026-05-27T10:14)

  it("sweeps ALL expired entries incl. an abandoned other-project one, warning once", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_abandoned", query: "q", project_id: "0000000other0000", created_at: EXPIRED, attempts: 2 },
        { estimate_id: "est_mine_old", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: EXPIRED, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const errs: string[] = [];

    const code = await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
    });

    expect(code).toBe(0);
    // The abandoned OTHER-project entry — which no per-entry drop would ever have
    // selected — is swept too.
    expect(readPending(home).entries).toEqual([]);
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(errs.join("")).toContain("dropped 2 pending estimates past the 24h retry window");
  });

  it("sweeps an expired sibling but still submits the recent entry", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_old", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: EXPIRED, attempts: 0 },
        { estimate_id: "est_recent", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const fake = makeFakeClient();

    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 7, tokensOut: 8, trace: [] }),
    });

    expect(fake.submitActuals.mock.calls[0]![0].estimateId).toBe("est_recent");
    expect(readPending(home).entries).toEqual([]); // old swept, recent submitted
  });

  it("KEEPS an entry with an unparseable created_at, and never mis-pairs onto it", async () => {
    // Regression for the mis-pair the adversarial review caught: the sweep keeps
    // an unknown-age (unparseable created_at) entry, so it reaches selection. It
    // belongs to THIS project (so newestForProject would pick it), yet a FRESH
    // submit must NOT attach this session's usage to an estimate of unknown
    // provenance — the fresh-path age guard blocks it. (The earlier version of
    // this test used a FOREIGN project_id, which masked the bug via a null select.)
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_weird", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: "not-a-date", attempts: 0 },
      ],
    });
    const fake = makeFakeClient();
    const errs: string[] = [];

    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 999999, tokensOut: 888888, trace: [] }),
    });

    // Unknown age → kept (not swept), and NOT submitted (age guard blocks the
    // fresh mis-pair). Same guard covers a stale entry that survives a
    // sweep-write fault.
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending(home).entries.map((e) => e.estimate_id)).toEqual(["est_weird"]);
    expect(errs.join("")).not.toContain("dropped");
  });
});

// ---------------------------------------------------------------------------
// Store integrity under concurrency (the shared ~/.budgetary/pending.json is
// written by multiple sessions and both plugins).
// ---------------------------------------------------------------------------

describe("submitActuals — store integrity under concurrency", () => {
  it("preserves a concurrent append made during an in-flight submit", async () => {
    const path = join(home, ".budgetary", "pending.json");
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_inflight", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const store = new PendingStore({ path });
    const entry = store.read().entries[0]!;

    // A submit that blocks on the "network" until we release it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = makeFakeClient(async () => {
      await gate;
      return { received: true, ledgerEntryId: "led" };
    });

    const submitting = submitActuals({
      store,
      client: asClient(fake),
      entry,
      counts: { tokensIn: 1, tokensOut: 1, success: true, durationMs: 0 },
    });

    // Mid-flight, another session appends a new pending entry to the store.
    new PendingStore({ path }).append({
      estimate_id: "est_concurrent",
      query: "q",
      project_id: "p2",
      created_at: RECENT,
      attempts: 0,
    });

    release();
    await submitting;

    // The in-flight entry is closed; the concurrently-appended one SURVIVES.
    // The old snapshot-write (pop + write pre-read file) would have lost it.
    expect(readPending(home).entries.map((e) => e.estimate_id)).toEqual([
      "est_concurrent",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Retry cap on the non-interactive submit paths (P-A2). A server outage must
// not stall session exit (the hook runs inside a 30s host budget) or the
// foreground caller; a failed submit stays pending for a later session instead.
// The interactive `estimate` path is deliberately NOT capped (covered there).
// ---------------------------------------------------------------------------

describe("non-interactive actuals paths cap SDK retries", () => {
  // Capture the options the path hands the client factory.
  let opts: import("@budgetary/sdk").BudgetaryClientOptions | undefined;
  const capturing =
    (fake: FakeClient) =>
    (o: import("@budgetary/sdk").BudgetaryClientOptions) => {
      opts = o;
      return asClient(fake);
    };

  beforeEach(() => {
    opts = undefined;
  });

  function seed(estimateId: string) {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: estimateId, query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
  }

  it("auto (session-end hook) constructs the client with maxRetries: 0", async () => {
    seed("est_auto_cap");
    await runAutoActuals({
      payload: { transcript_path: "/tmp/t.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: capturing(makeFakeClient()),
      readUsage: () => ({ tokensIn: 1, tokensOut: 1, trace: [] }),
    });
    expect(opts?.maxRetries).toBe(0);
    // Still forwards the real config alongside the cap.
    expect(opts?.apiKey).toBe("bg_test_dummy");
  });

  it("rollout (on-session-end --transcript) constructs the client with maxRetries: 0", async () => {
    seed("est_rollout_cap");
    await runRolloutActuals({
      transcriptPath: "/tmp/rollout.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: () => {},
      clientFactory: capturing(makeFakeClient()),
      readUsage: () => ({ tokensIn: 1, tokensOut: 1, trace: [] }),
    });
    expect(opts?.maxRetries).toBe(0);
  });

  it("manual (report-actual) constructs the client with maxRetries: 0", async () => {
    seed("est_manual_cap");
    await runManualActuals({
      env: ENV,
      home,
      out: () => {},
      prompt: scriptedPrompt(["1", "1", "y", "0"]),
      clientFactory: capturing(makeFakeClient()),
    });
    expect(opts?.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PR-1: the unattended (session-end hook) path is observable — a durable
// breadcrumb every run, and BUDGETARY_DEBUG stderr narration of each decision.
// ---------------------------------------------------------------------------

describe("runAutoActuals — breadcrumb (the only durable instrument)", () => {
  const PAYLOAD = { transcript_path: "/tmp/transcript.jsonl", reason: "clear" };
  const STALE = "2026-05-26T08:00:00Z"; // > 24h before NOW (10:14 on the 27th)

  function seed(estimateId: string, extra: Partial<PendingEntry> = {}) {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: estimateId,
          query: "q",
          project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT,
          attempts: 0,
          ...extra,
        },
      ],
    });
  }

  async function runAuto(over: Partial<Parameters<typeof runAutoActuals>[0]> = {}) {
    return runAutoActuals({
      payload: PAYLOAD,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
      ...over,
    });
  }

  it("records 'submitted' with the estimate id on success", async () => {
    seed("est_ok");
    await runAuto({ clientFactory: () => asClient(makeFakeClient()) });
    const crumb = readBreadcrumb(home);
    expect(crumb?.outcome).toBe("submitted");
    expect(crumb?.estimateId).toBe("est_ok");
    expect(typeof crumb?.durationMs).toBe("number");
    expect(typeof crumb?.startedAt).toBe("string");
  });

  it("writes a start-ONLY breadcrumb BEFORE the work (the SIGKILL marker)", async () => {
    // The interrupted-run marker is only real if runAutoActuals actually persists
    // a start-only record before doing the work. Observe it mid-run (readUsage
    // runs after the start marker, before the finally overwrites it). Without the
    // pre-work write this fails — the finally alone would never leave a start-only
    // record on a completed run.
    seed("est_startmarker");
    let midRun: ReturnType<typeof readBreadcrumb> = null;
    await runAuto({
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => {
        midRun = readBreadcrumb(home);
        return { tokensIn: 5, tokensOut: 5, trace: [] };
      },
    });
    expect(midRun).not.toBeNull();
    expect(midRun!.startedAt).toBeTruthy();
    expect(midRun!.outcome).toBeUndefined(); // start-only ⇒ interrupted marker
    expect(midRun!.durationMs).toBeUndefined();
    // ...then overwritten with the completed record.
    expect(readBreadcrumb(home)?.outcome).toBe("submitted");
  });

  it("records 'no-entry' when the store is empty", async () => {
    writePending(home, { version: 1, entries: [] });
    await runAuto({ clientFactory: () => asClient(makeFakeClient()) });
    expect(readBreadcrumb(home)?.outcome).toBe("no-entry");
  });

  it("records 'dropped-ttl' when the TTL sweep drains the queue", async () => {
    seed("est_stale", { created_at: STALE });
    await runAuto({ clientFactory: () => asClient(makeFakeClient()) });
    expect(readBreadcrumb(home)?.outcome).toBe("dropped-ttl");
    // ...and the entry really was swept (dropped-ttl means DROPPED).
    expect(readPending(home).entries).toEqual([]);
  });

  it("records 'stale-skip' (NOT dropped-ttl) for a kept entry with an unparseable created_at", async () => {
    // sweepExpired keeps unknown-age entries, so this reaches the fresh-path
    // re-guard. The breadcrumb must NOT claim the entry expired — it's still here.
    seed("est_badts", { created_at: "not-a-real-date" });
    await runAuto({ clientFactory: () => asClient(makeFakeClient()) });
    expect(readBreadcrumb(home)?.outcome).toBe("stale-skip");
    // The entry is KEPT — the honesty point of the split.
    expect(readPending(home).entries.map((e) => e.estimate_id)).toEqual(["est_badts"]);
  });

  it("records 'no-usage' when the transcript yields no counts", async () => {
    seed("est_nousage");
    await runAuto({
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => null,
    });
    expect(readBreadcrumb(home)?.outcome).toBe("no-usage");
  });

  it("records 'no-key' when no API key is configured", async () => {
    seed("est_nokey");
    await runAuto({ env: {}, clientFactory: () => asClient(makeFakeClient()) });
    expect(readBreadcrumb(home)?.outcome).toBe("no-key");
  });

  it("records 'rejected' on a terminal 4xx", async () => {
    seed("est_rej");
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "not_found", message: "gone", httpStatus: 404, requestId: "r" });
    });
    await runAuto({ clientFactory: () => asClient(fake), stderr: { write: () => {} } });
    expect(readBreadcrumb(home)?.outcome).toBe("rejected");
  });

  it("records 'failed:503' on a retryable transport failure (entry kept)", async () => {
    seed("est_5xx");
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "unavailable", message: "down", httpStatus: 503, requestId: null });
    });
    await runAuto({ clientFactory: () => asClient(fake) });
    expect(readBreadcrumb(home)?.outcome).toBe("failed:503");
    expect(readPending(home).entries).toHaveLength(1); // kept for retry
  });

  it("records 'gave-up' when attempts reach the cap", async () => {
    seed("est_giveup", { attempts: 4 }); // MAX_ATTEMPTS is 5
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "unavailable", message: "down", httpStatus: 503, requestId: null });
    });
    await runAuto({ clientFactory: () => asClient(fake), stderr: { write: () => {} } });
    expect(readBreadcrumb(home)?.outcome).toBe("gave-up");
  });

  it("stamps the realized counts + forecast band so the loop closes for the human (T-1)", async () => {
    seed("est_loop", { forecast_p10: 12500, forecast_p50: 48000, forecast_p90: 220000 });
    await runAuto({
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => ({ tokensIn: 20000, tokensOut: 32000, trace: [] }),
    });
    const crumb = readBreadcrumb(home);
    expect(crumb?.outcome).toBe("submitted");
    expect(crumb?.tokensIn).toBe(20000);
    expect(crumb?.tokensOut).toBe(32000);
    expect(crumb?.forecastP10).toBe(12500);
    expect(crumb?.forecastP50).toBe(48000);
    expect(crumb?.forecastP90).toBe(220000);
  });

  it("stamps the measured counts even when the submit fails (they were really measured)", async () => {
    seed("est_loop_fail", { forecast_p50: 48000, forecast_p10: 12500, forecast_p90: 220000 });
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({ code: "unavailable", message: "down", httpStatus: 503, requestId: null });
    });
    await runAuto({
      clientFactory: () => asClient(fake),
      readUsage: () => ({ tokensIn: 20000, tokensOut: 32000, trace: [] }),
    });
    const crumb = readBreadcrumb(home);
    expect(crumb?.outcome).toBe("failed:503");
    expect(crumb?.tokensIn).toBe(20000);
    expect(crumb?.forecastP50).toBe(48000);
  });

  it("omits the counts when the run recorded none (no-usage)", async () => {
    seed("est_nocounts", { forecast_p50: 48000 });
    await runAuto({
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => null,
    });
    const crumb = readBreadcrumb(home);
    expect(crumb?.outcome).toBe("no-usage");
    expect(crumb?.tokensIn).toBeUndefined();
    expect(crumb?.tokensOut).toBeUndefined();
  });

  it("does NOT re-derive the unreadable-reason with BUDGETARY_DEBUG off (L-1 perf gate)", async () => {
    const spy = vi.spyOn(transcriptModule, "transcriptUnreadableReason");
    seed("est_gate_off");
    await runAuto({
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => null,
    });
    expect(readBreadcrumb(home)?.outcome).toBe("no-usage");
    // The gate must skip the whole-transcript re-read entirely (not just discard it).
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("DOES name the unreadable-reason under BUDGETARY_DEBUG=1", async () => {
    const spy = vi
      .spyOn(transcriptModule, "transcriptUnreadableReason")
      .mockReturnValue("transcript format changed");
    seed("est_gate_on");
    await runAuto({
      env: { ...ENV, BUDGETARY_DEBUG: "1" },
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => null,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("runAutoActuals — BUDGETARY_DEBUG narration (never the key)", () => {
  const PAYLOAD = { transcript_path: "/tmp/transcript.jsonl", reason: "clear" };
  const DEBUG_ENV = { BUDGETARY_API_KEY: "bg_test_secretvalue", BUDGETARY_DEBUG: "1" } as NodeJS.ProcessEnv;

  function seed(id: string) {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: id, query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
  }

  it("is silent on stderr without the flag", async () => {
    seed("est_quiet");
    const errs: string[] = [];
    await runAutoActuals({
      payload: PAYLOAD, env: ENV, home, cwd, now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
    });
    expect(errs.join("")).toBe("");
  });

  it("narrates each decision under the flag, naming the reason on a no-op", async () => {
    seed("est_dbg");
    const errs: string[] = [];
    await runAutoActuals({
      payload: PAYLOAD, env: DEBUG_ENV, home, cwd, now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => null, // force the no-usage branch to name itself
    });
    const text = errs.join("");
    expect(text).toContain("Budgetary: session-end:");
    expect(text).toContain("started");
    expect(text).toContain("matched estimate_id=est_dbg");
    // Names WHY the transcript was unusable (the real /tmp path does not exist),
    // rather than a bare "null" — the transcriptUnreadableReason diagnostic.
    expect(text).toContain("fresh path aborted: transcript file does not exist");
    expect(text).toContain("finished outcome=no-usage");
  });

  it("logs the key SOURCE and base URL but NEVER the key value", async () => {
    seed("est_secret");
    const errs: string[] = [];
    await runAutoActuals({
      payload: PAYLOAD, env: DEBUG_ENV, home, cwd, now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
    });
    const text = errs.join("");
    expect(text).toContain("key source=env");
    expect(text).not.toContain("bg_test_secretvalue");
    expect(text).toContain("submit outcome=submitted");
    // PRIME DIRECTIVE #1 also covers the persisted breadcrumb FILE, not just stderr.
    const crumbRaw = readFileSync(join(home, ".budgetary", "last-session-end.json"), "utf8");
    expect(crumbRaw).not.toContain("bg_test_secretvalue");
    expect(crumbRaw).not.toContain("bg_test_");
  });
});

describe("runAutoActuals — fails closed to exit 0 even when a dependency throws", () => {
  async function* streamOf(...chunks: string[]): AsyncGenerator<string> {
    for (const chunk of chunks) yield chunk;
  }

  it("a throwing client factory still exits 0 (via the CLI backstop) + records 'error'", async () => {
    writePending(home, {
      version: 1,
      entries: [
        { estimate_id: "est_boom", query: "q", project_id: projectIdFromCwd(cwd, home), created_at: RECENT, attempts: 0 },
      ],
    });
    const errs: string[] = [];
    const payload = { transcript_path: "/tmp/t.jsonl", reason: "clear", cwd };
    const code = await runOnSessionEndCli([], {
      stdin: streamOf(JSON.stringify(payload)),
      stderr: { write: (s) => errs.push(s) },
      env: ENV,
      runAuto: (a) =>
        runAutoActuals({
          ...a,
          home,
          cwd,
          now: () => NOW,
          clientFactory: () => {
            throw new Error("boom from the store");
          },
          readUsage: () => ({ tokensIn: 5, tokensOut: 5, trace: [] }),
        }),
    });
    expect(code).toBe(0);
    expect(errs.join("")).toContain("unexpected error");
    expect(readBreadcrumb(home)?.outcome).toBe("error");
  });
});

describe("runPendingList — surfaces the last automatic run", () => {
  it("prints a 'submitted' header, truncating a long id and naming the age", () => {
    writePending(home, { version: 1, entries: [] });
    // A >12-char id exercises the ellipsis truncation; RECENT vs NOW = 14m.
    writeBreadcrumbForTest(RECENT, "submitted", "est_abcdefghijklmnop");
    const out: string[] = [];
    runPendingList({ env: ENV, home, now: () => NOW, out: (l) => out.push(l) });
    const text = out.join("\n");
    // Truncated to 12 chars + ellipsis, and the age tail is present.
    expect(text).toContain("Last automatic submission: submitted (est_abcdefgh…), 14m ago.");
    expect(text).not.toContain("est_abcdefghijklmnop"); // full id never shown
    expect(text).toContain("No pending Budgetary estimates awaiting actuals.");
  });

  it("flags an interrupted (SIGKILLed) run from a start-only breadcrumb", () => {
    writePending(home, { version: 1, entries: [] });
    // A start-only record — no outcome/duration — is the SIGKILL marker.
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "last-session-end.json"),
      JSON.stringify({ startedAt: "2026-05-27T10:00:00Z" }),
      "utf8",
    );
    const out: string[] = [];
    runPendingList({ env: ENV, home, now: () => NOW, out: (l) => out.push(l) });
    expect(out.join("\n")).toContain("did not finish (interrupted)");
  });

  it("prints no header when no automatic run was ever recorded", () => {
    writePending(home, { version: 1, entries: [] });
    const out: string[] = [];
    runPendingList({ env: ENV, home, now: () => NOW, out: (l) => out.push(l) });
    expect(out.join("\n")).not.toContain("Last automatic");
  });

  it("closes the loop in the header when the breadcrumb carries counts + band (T-1)", () => {
    writePending(home, { version: 1, entries: [] });
    writeBreadcrumb(home, {
      startedAt: RECENT,
      durationMs: 3,
      outcome: "submitted",
      estimateId: "est_loop",
      tokensIn: 20000,
      tokensOut: 32000,
      forecastP10: 12500,
      forecastP50: 48000,
      forecastP90: 220000,
    });
    const out: string[] = [];
    runPendingList({ env: ENV, home, now: () => NOW, out: (l) => out.push(l) });
    const text = out.join("\n");
    // The human sees "forecast ~48,000 → actual 52,000 (within band)" without ever
    // opening the VS Code dashboard.
    expect(text).toContain("actual 52,000 tokens vs forecast ~48,000 (within p10–p90)");
    expect(text).not.toContain("$");
  });
});

describe("runPendingList — per-row forecast / actual (T-1)", () => {
  it("shows the forecast on an open banded row, and actual-vs-forecast on a measured one", () => {
    writePending(home, {
      version: 1,
      entries: [
        // Open (not yet measured) but banded → shows the forecast alone.
        {
          estimate_id: "est_open", query: "q1", project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT, attempts: 0,
          forecast_p10: 100, forecast_p50: 500, forecast_p90: 2000,
        },
        // Measured (prior failed submit) AND banded → shows actual vs forecast.
        {
          estimate_id: "est_meas", query: "q2", project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT, attempts: 1,
          tokens_in: 300, tokens_out: 180, success: true, duration_ms: 9,
          forecast_p10: 100, forecast_p50: 500, forecast_p90: 2000,
        },
      ],
    });
    const out: string[] = [];
    runPendingList({ env: ENV, home, cwd, now: () => NOW, out: (l) => out.push(l) });
    const open = out.find((l) => l.includes("id est_open"))!;
    expect(open).toContain("forecast ~500 tokens (p10–p90 100–2,000)");
    const meas = out.find((l) => l.includes("id est_meas"))!;
    expect(meas).toContain("actual 480 tokens vs forecast ~500 (within p10–p90)");
    // The measured+banded row upgrades past the bare "measured ✓" marker.
    expect(meas).not.toContain("measured ✓");
  });
});

// Small helper: seed a completed breadcrumb via the real writer.
function writeBreadcrumbForTest(startedAt: string, outcome: string, estimateId: string) {
  writeBreadcrumb(home, { startedAt, durationMs: 3, outcome, estimateId });
}

// ---------------------------------------------------------------------------
// Provenance (`metadata.source`)
//
// The tag is a property of the RUN, not of the process that reports it. The
// actuals path is cross-session AND cross-process: the estimate happens in the
// MCP server process, the submit in a separate SessionEnd hook, and a FAILED
// submit is queued and retried by some LATER session under whatever environment
// that session happens to have. So the tag is resolved ONCE (at estimate time),
// persisted on the entry, and re-read from the entry at submit — the submit path
// never reads `process.env`. These tests pin that, since both failure modes are
// silent: a dropped tag (the run contributes nothing) and, worse, an inherited
// one (a foreign run is mislabeled).
// ---------------------------------------------------------------------------

describe("provenance: metadata.source", () => {
  const PAYLOAD = { transcript_path: "/tmp/transcript.jsonl", reason: "clear" };
  const USAGE = { tokensIn: 1000, tokensOut: 2000, trace: [] };

  /** Run the REAL estimate tool under `env`, creating a real pending entry. */
  async function estimateUnder(env: NodeJS.ProcessEnv, estimateId = "est_run") {
    const fake = makeFakeClient();
    fake.estimate = vi.fn(
      async (): Promise<EstimateResponse> => ({
        estimateId,
        scenario: "confident",
        void: false,
        distribution: { p10: 100, p50: 500, p90: 2000, unit: "tokens" },
        confidence: 0.7,
        model: "m",
        expiresAt: "",
      }),
    );
    const result = await runEstimateTool({
      query: "fix the failing parser test",
      env: { ...ENV, ...env },
      cwd,
      home,
      now: () => NOW,
      clientFactory: () => asClient(fake),
    });
    expect(result.isError).toBe(false);
    return result;
  }

  /** A submit that fails transiently (network) — the entry is kept and queued. */
  const networkFailure = async (): Promise<never> => {
    throw new BudgetaryError({
      code: "network_error",
      message: "connection reset",
      httpStatus: null,
      requestId: null,
    });
  };

  /** Run the REAL session-end path under `env`; returns the fake client. */
  async function sessionEndUnder(
    env: NodeJS.ProcessEnv,
    submitImpl?: () => Promise<ActualsResponse>,
  ) {
    const fake = makeFakeClient(submitImpl);
    await runAutoActuals({
      payload: PAYLOAD,
      env: { ...ENV, ...env },
      home,
      cwd,
      now: () => NOW,
      stderr: { write: () => {} },
      clientFactory: () => asClient(fake),
      readUsage: () => USAGE,
    });
    return fake;
  }

  // === THE POINT OF THE WHOLE ITEM ===
  it("a queued retry re-sends the RUN's tag, from a later session with NO env var", async () => {
    // 1. A benchmark run: the estimate is made with the tag declared.
    await estimateUnder({ BUDGETARY_SOURCE: "swe-bench" });
    expect(readPending(home).entries[0]!.source).toBe("swe-bench");

    // 2. Its submit hits a network blip and is queued (entry kept, attempts+1).
    const failing = await sessionEndUnder(
      { BUDGETARY_SOURCE: "swe-bench" },
      networkFailure,
    );
    expect(failing.submitActuals).toHaveBeenCalledTimes(1);
    const kept = readPending(home).entries;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.attempts).toBe(1);
    // withPersistedCounts spreads `...entry` — assert that it PRESERVED the tag
    // rather than assuming it (the whole retry hinges on this field surviving).
    expect(kept[0]!.source).toBe("swe-bench");
    expect(kept[0]!.tokens_in).toBe(1000);

    // 3. NEXT WEEK: an ordinary session — no BUDGETARY_SOURCE anywhere — retries it.
    const retry = await sessionEndUnder({});
    const sent = retry.submitActuals.mock.calls[0]![0];
    // It must still be the BENCHMARK's tag. If this read the environment it would
    // silently default to "mcp_client", and the run would contribute nothing.
    expect(sent.metadata).toEqual({ source: "swe-bench" });
    expect(sent.estimateId).toBe("est_run");
    expect(readPending(home).entries).toEqual([]);
  });

  it("a queued entry retried INSIDE a tagged session keeps its OWN tag (no mislabel)", async () => {
    // The inverse, and the more damaging direction: an ORDINARY run's queued
    // entry must not inherit the tag of whatever session happens to retry it. If
    // it did, an ordinary run would enter the corpus under benchmark provenance —
    // and a held-out benchmark task landing in the corpus it is evaluated against
    // makes every accuracy number from that split circular.
    await estimateUnder({}); // no tag: an ordinary session
    await sessionEndUnder({}, networkFailure);
    expect(readPending(home).entries[0]!.source).toBe("mcp_client");

    // A benchmark session later drains the queue.
    const retry = await sessionEndUnder({ BUDGETARY_SOURCE: "swe-bench" });
    const sent = retry.submitActuals.mock.calls[0]![0];
    expect(sent.metadata).toEqual({ source: "mcp_client" });
  });

  it("sends the default when no env var is set at all", async () => {
    await estimateUnder({});
    const fake = await sessionEndUnder({});
    expect(fake.submitActuals.mock.calls[0]![0].metadata).toEqual({
      source: "mcp_client",
    });
  });

  it("sends the declared tag on the ordinary (first-try) submit", async () => {
    await estimateUnder({ BUDGETARY_SOURCE: "swe-bench" });
    const fake = await sessionEndUnder({ BUDGETARY_SOURCE: "swe-bench" });
    expect(fake.submitActuals.mock.calls[0]![0].metadata).toEqual({
      source: "swe-bench",
    });
  });

  it("forwards an OPAQUE tag — the client knows no lane vocabulary", async () => {
    // A tag the client has never heard of must pass through untouched: the server
    // owns the vocabulary, so a new lane needs no client release. (Shape only is
    // validated — never meaning.)
    await estimateUnder({ BUDGETARY_SOURCE: "some.future-lane_v2" });
    const fake = await sessionEndUnder({});
    expect(fake.submitActuals.mock.calls[0]![0].metadata).toEqual({
      source: "some.future-lane_v2",
    });
  });

  // --- Backward compatibility -----------------------------------------------

  it("an entry from a pre-0024b client (no `source`) submits the default, never undefined", async () => {
    // Hand-written v1 entry, exactly as an older client would have left it — and
    // note it is a RETRY (it carries persisted counts), the path most likely to be
    // holding an old entry when this ships.
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_old",
          query: "q",
          project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT,
          attempts: 1,
          tokens_in: 5, tokens_out: 6, success: true, duration_ms: 7,
        },
      ],
    });
    const fake = await sessionEndUnder({ BUDGETARY_SOURCE: "swe-bench" });
    const sent = fake.submitActuals.mock.calls[0]![0];
    // The DEFAULT CONSTANT — not the environment. Falling back to the env here
    // would reintroduce the mislabel through the back door.
    expect(sent.metadata).toEqual({ source: "mcp_client" });
    expect(sent.metadata.source).not.toBeUndefined();
  });

  it("a corrupt/hand-edited `source` on disk degrades to the default (never reaches the wire)", async () => {
    writePending(home, {
      version: 1,
      entries: [
        {
          estimate_id: "est_corrupt",
          query: "q",
          project_id: projectIdFromCwd(cwd, home),
          created_at: RECENT,
          attempts: 1,
          tokens_in: 5, tokens_out: 6, success: true, duration_ms: 7,
          // Not something our writer can produce; a partial write or a hand-edit.
          source: "not a valid tag {}",
        } as PendingEntry,
      ],
    });
    const fake = await sessionEndUnder({});
    expect(fake.submitActuals.mock.calls[0]![0].metadata).toEqual({
      source: "mcp_client",
    });
  });

  // --- Fail-open validation --------------------------------------------------
  // A bad env value must never fail a submit, and must never be written to the
  // store. `metadata` is 2 KB-capped server-side (a published 413), so an
  // unbounded value would let a typo turn a real contribution into a rejection.

  const JUNK: Array<[string, string]> = [
    ["empty", ""],
    ["blank", "   "],
    ["500 chars", "x".repeat(500)],
    ["65 chars (one over the bound)", "x".repeat(65)],
    ["a space", "swe bench"],
    ["a brace", "swe{bench}"],
    ["a newline", "swe-bench\nrm -rf /"],
    ["a quote", 'swe"bench'],
  ];

  for (const [label, value] of JUNK) {
    it(`BUDGETARY_SOURCE with ${label} → default sent, submit still succeeds, junk never stored`, async () => {
      await estimateUnder({ BUDGETARY_SOURCE: value });

      // Never written to the store...
      const stored = readPending(home).entries[0]!;
      expect(stored.source).toBe("mcp_client");
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        // The junk itself is nowhere in the file — not under `source`, not anywhere.
        const raw = readFileSync(join(home, ".budgetary", "pending.json"), "utf8");
        expect(raw).not.toContain(trimmed);
      }

      // ...and the submit still succeeds, carrying the default.
      const fake = await sessionEndUnder({ BUDGETARY_SOURCE: value });
      expect(fake.submitActuals).toHaveBeenCalledTimes(1);
      expect(fake.submitActuals.mock.calls[0]![0].metadata).toEqual({
        source: "mcp_client",
      });
      expect(readPending(home).entries).toEqual([]); // submitted + removed
    });
  }

  it("a valid tag is trimmed of surrounding whitespace", async () => {
    await estimateUnder({ BUDGETARY_SOURCE: "  swe-bench  " });
    expect(readPending(home).entries[0]!.source).toBe("swe-bench");
  });

  // --- The other submit paths ------------------------------------------------

  it("the rollout path sends the entry's tag too", async () => {
    await estimateUnder({ BUDGETARY_SOURCE: "swe-bench" });
    const fake = makeFakeClient();
    const code = await runRolloutActuals({
      transcriptPath: "/tmp/rollout.jsonl",
      success: true,
      env: ENV, // no tag in THIS process
      home,
      cwd,
      now: () => NOW,
      out: () => {},
      clientFactory: () => asClient(fake),
      readUsage: () => USAGE,
    });
    expect(code).toBe(0);
    expect(fake.submitActuals.mock.calls[0]![0].metadata).toEqual({
      source: "swe-bench",
    });
  });

  it("the manual --estimate-id path sends the ENTRY's tag when a real row exists", async () => {
    // A harness driver must use --estimate-id to close the RIGHT estimate when
    // several sessions share one cwd. If this path ignored the row sitting in the
    // store, it would POST the default AND then remove that row on success —
    // destroying the only copy of a tag the run genuinely declared. The tag comes
    // from the ENTRY here, exactly as on every other submit path.
    await estimateUnder({ BUDGETARY_SOURCE: "swe-bench" }, "est_byid");
    expect(readPending(home).entries[0]!.source).toBe("swe-bench");

    const fake = makeFakeClient();
    const out: string[] = [];
    const code = await runManualActuals({
      env: ENV, // no tag in THIS process — it must come off the entry
      home,
      estimateId: "est_byid",
      out: (l) => out.push(l),
      prompt: scriptedPrompt(["10", "20", "y", "30"]),
      clientFactory: () => asClient(fake),
    });
    expect(code).toBe(0);
    expect(fake.submitActuals.mock.calls[0]![0].metadata).toEqual({
      source: "swe-bench",
    });
    // Finding the real row also recovers its forecast band, for free.
    expect(out.join("\n")).toContain("Forecast check:");
    expect(readPending(home).entries).toEqual([]);
  });

  it("the manual --estimate-id path sends the default when NO row exists (never the env)", async () => {
    // The path's original purpose: a billed estimate whose local row was never
    // written. There is no entry, so there is no tag — and it must take the default
    // CONSTANT, not the ambient environment, even inside a tagged shell.
    writePending(home, { version: 1, entries: [] });
    const fake = makeFakeClient();
    const code = await runManualActuals({
      env: { ...ENV, BUDGETARY_SOURCE: "swe-bench" },
      home,
      estimateId: "est_nowhere",
      out: () => {},
      prompt: scriptedPrompt(["10", "20", "y", "30"]),
      clientFactory: () => asClient(fake),
    });
    expect(code).toBe(0);
    expect(fake.submitActuals.mock.calls[0]![0].metadata).toEqual({
      source: "mcp_client",
    });
  });
});
