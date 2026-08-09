import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActualsResponse,
  EstimateResponse,
  LedgerPage,
} from "@budgetary/sdk";

import { reconcileEntry } from "../src/reconcile.js";
import {
  claudeProjectSlug,
  entryBinding,
  processAlive,
  resolveSessionBinding,
  selectReconcilable,
  SESSION_ID_ENV,
  PROJECT_DIR_ENV,
} from "../src/session.js";
import { runEstimateTool, projectIdFromCwd } from "../src/tools/estimate.js";
import type { PendingEntry, PendingStoreFile } from "../src/store.js";
import * as transcriptModule from "../src/transcript.js";

interface FakeClient {
  estimate: ReturnType<typeof vi.fn>;
  submitActuals: ReturnType<typeof vi.fn>;
  getLedger: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return {
    estimate: vi.fn(
      async (): Promise<EstimateResponse> => ({
        estimateId: "est_new",
        scenario: "confident",
        void: false,
        distribution: { p10: 100, p50: 200, p90: 300, unit: "tokens" },
        confidence: 0.7,
        model: "claude-opus-4-7",
        expiresAt: "2026-05-27T10:14:00Z",
      }),
    ),
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

const asClient = (fake: FakeClient) =>
  fake as unknown as import("@budgetary/sdk").BudgetaryClient;

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-home-"));
  cwd = mkdtempSync(join(tmpdir(), "budgetary-cwd-"));
});

afterEach(() => {
  // Unconditional, so one failing assertion cannot leak a live spy into every
  // later test in this file (a `mockRestore()` at the end of a body is only
  // reached on the happy path).
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const ENV_KEY = { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv;
const SESSION_A = "aaaaaaaa-1111-4222-8333-444444444444";
const SESSION_B = "bbbbbbbb-1111-4222-8333-444444444444";
const TOOL_USE_A = "toolu_01AAAAAAAAAAAAAAAAAAAAAA";
const TOOL_USE_B = "toolu_01BBBBBBBBBBBBBBBBBBBBBB";

/**
 * A pid that is genuinely not running. Found by probing rather than assumed —
 * the entire liveness gate rests on `processAlive` being able to answer this, so
 * a suite that merely hoped would hide the failure it is meant to catch.
 */
function findDeadPid(): number {
  for (let pid = 4_000_000; pid > 100_000; pid--) {
    if (!processAlive(pid)) return pid;
  }
  throw new Error("no dead pid available on this machine");
}
const DEAD_PID = findDeadPid();

/** The Claude Code transcript directory for `cwd`, created on disk. */
function transcriptDir(): string {
  const dir = join(home, ".claude", "projects", claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a Claude Code-shaped transcript: one assistant turn carrying usage and a
 * `tool_use` block whose id is the host's tool-use id, plus its `tool_result`.
 * Real JSONL, parsed by the real reader — the transcript format is the thing
 * under test, so it is never mocked.
 */
function writeTranscript(
  dir: string,
  sessionId: string,
  toolUseId: string,
  usage: { input: number; output: number },
  extraTool = "Bash",
): string {
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "assistant",
      sessionId,
      message: {
        id: "msg_1",
        usage: { input_tokens: usage.input, output_tokens: usage.output },
        content: [
          { type: "tool_use", id: toolUseId, name: "mcp__budgetary__estimate", input: {} },
          { type: "tool_use", id: "toolu_other", name: extraTool, input: { command: "ls" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      sessionId,
      message: {
        content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false }],
      },
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function pendingPath(): string {
  return join(home, ".budgetary", "pending.json");
}

function writePending(entries: PendingEntry[]): void {
  mkdirSync(join(home, ".budgetary"), { recursive: true });
  const file: PendingStoreFile = { version: 1, entries };
  writeFileSync(pendingPath(), JSON.stringify(file));
}

function readPending(): PendingStoreFile {
  return JSON.parse(readFileSync(pendingPath(), "utf8")) as PendingStoreFile;
}

/** An entry for a FINISHED session A, fully bound. */
function entryA(over: Partial<PendingEntry> = {}): PendingEntry {
  return {
    estimate_id: "est_A",
    query: "session A task",
    project_id: projectIdFromCwd(cwd, home),
    created_at: new Date(Date.now() - 60_000).toISOString(),
    attempts: 0,
    source: "mcp_client",
    session_id: SESSION_A,
    tool_use_id: TOOL_USE_A,
    transcript_dir: join(home, ".claude", "projects", claudeProjectSlug(cwd)),
    owner_pid: DEAD_PID,
    ...over,
  };
}

/** Let the deferred (setImmediate + dynamic import) reconcile run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------

describe("processAlive — the liveness gate", () => {
  it("reports this process alive and an unused pid dead", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(DEAD_PID)).toBe(false);
  });
});

describe("claudeProjectSlug — the host's transcript directory name", () => {
  it("maps every non-alphanumeric byte to a dash", () => {
    expect(claudeProjectSlug("/Users/x/SWR")).toBe("-Users-x-SWR");
    // `/`, `_`, `.` and a space all collapse — the mapping is lossy, which is
    // why a slug may only narrow the search and never prove a match.
    expect(claudeProjectSlug("/a/b_c.d e")).toBe("-a-b-c-d-e");
  });
});

describe("resolveSessionBinding — all four fields or none", () => {
  it("captures the binding when the host supplies everything", () => {
    transcriptDir();
    const b = resolveSessionBinding({
      env: { ...ENV_KEY, [SESSION_ID_ENV]: SESSION_A, [PROJECT_DIR_ENV]: cwd },
      cwd,
      toolUseId: TOOL_USE_A,
      home,
      pid: 4242,
    });
    expect(b).toEqual({
      sessionId: SESSION_A,
      toolUseId: TOOL_USE_A,
      transcriptDir: join(home, ".claude", "projects", claudeProjectSlug(cwd)),
      ownerPid: 4242,
    });
  });

  it("returns null on a non-Claude-Code host (no session id in the environment)", () => {
    transcriptDir();
    expect(
      resolveSessionBinding({ env: ENV_KEY, cwd, toolUseId: TOOL_USE_A, home }),
    ).toBeNull();
  });

  it("returns null when the host sent no tool-use id", () => {
    transcriptDir();
    expect(
      resolveSessionBinding({
        env: { [SESSION_ID_ENV]: SESSION_A, [PROJECT_DIR_ENV]: cwd },
        cwd,
        home,
      }),
    ).toBeNull();
  });

  it("returns null when no transcript directory exists for this project", () => {
    // Deliberately NOT creating it.
    expect(
      resolveSessionBinding({
        env: { [SESSION_ID_ENV]: SESSION_A, [PROJECT_DIR_ENV]: cwd },
        cwd,
        toolUseId: TOOL_USE_A,
        home,
      }),
    ).toBeNull();
  });

  it("rejects a session id that is not a UUID — it is used as a filename", () => {
    transcriptDir();
    for (const bad of ["../../etc/passwd", "a/b", "", "not-a-uuid", `${SESSION_A}\0x`]) {
      expect(
        resolveSessionBinding({
          env: { [SESSION_ID_ENV]: bad, [PROJECT_DIR_ENV]: cwd },
          cwd,
          toolUseId: TOOL_USE_A,
          home,
        }),
      ).toBeNull();
    }
  });
});

describe("entryBinding — re-validated at read time, never trusted", () => {
  it("accepts a complete binding and rejects every partial one", () => {
    expect(entryBinding(entryA())).not.toBeNull();
    for (const missing of [
      "session_id",
      "tool_use_id",
      "transcript_dir",
      "owner_pid",
    ] as const) {
      const e = entryA();
      delete e[missing];
      expect(entryBinding(e)).toBeNull();
    }
  });

  it("rejects a hand-edited pid or session id", () => {
    expect(entryBinding(entryA({ owner_pid: 0 }))).toBeNull();
    expect(entryBinding(entryA({ owner_pid: -1 }))).toBeNull();
    expect(entryBinding(entryA({ session_id: "../x" }))).toBeNull();
  });
});

describe("selectReconcilable — the cheap gate on the interactive path", () => {
  const nowMs = Date.now();

  it("selects a finished session's entry", () => {
    const picked = selectReconcilable({
      projectId: projectIdFromCwd(cwd, home),
      entries: [entryA()],
      excludeEstimateId: "est_new",
      currentSessionId: SESSION_B,
      nowMs,
    });
    expect(picked?.estimate_id).toBe("est_A");
  });

  it("never selects the entry this estimate just wrote", () => {
    expect(
      selectReconcilable({
        projectId: projectIdFromCwd(cwd, home),
      entries: [entryA()],
        excludeEstimateId: "est_A",
        currentSessionId: SESSION_B,
        nowMs,
      }),
    ).toBeNull();
  });

  it("leaves an entry whose session is the one we are running in", () => {
    expect(
      selectReconcilable({
        projectId: projectIdFromCwd(cwd, home),
      entries: [entryA()],
        excludeEstimateId: "est_new",
        currentSessionId: SESSION_A,
        nowMs,
      }),
    ).toBeNull();
  });

  it("leaves an entry whose serving process is still alive", () => {
    expect(
      selectReconcilable({
        projectId: projectIdFromCwd(cwd, home),
      entries: [entryA({ owner_pid: process.pid })],
        excludeEstimateId: "est_new",
        currentSessionId: SESSION_B,
        nowMs,
      }),
    ).toBeNull();
  });

  it("leaves an unbound entry — anything an earlier client wrote — strictly alone", () => {
    const legacy: PendingEntry = {
      estimate_id: "est_legacy",
      query: "old",
      project_id: "p",
      created_at: new Date().toISOString(),
      attempts: 0,
    };
    expect(
      selectReconcilable({
        projectId: projectIdFromCwd(cwd, home),
      entries: [legacy],
        excludeEstimateId: "est_new",
        currentSessionId: SESSION_B,
        nowMs,
      }),
    ).toBeNull();
  });

  it("leaves an entry past the TTL", () => {
    const old = entryA({
      created_at: new Date(nowMs - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(
      selectReconcilable({
        projectId: projectIdFromCwd(cwd, home),
      entries: [old],
        excludeEstimateId: "est_new",
        currentSessionId: SESSION_B,
        nowMs,
      }),
    ).toBeNull();
  });

  it("★ leaves BOTH alone when one session produced two estimates", () => {
    // A transcript measures the WHOLE session, so it can honestly close exactly
    // one estimate. Handing that single total to each entry in turn would file
    // the same tokens twice. There is no way to split it per estimate, so
    // neither is eligible and the session contributes nothing.
    const first = entryA({ estimate_id: "est_1", tool_use_id: "toolu_first" });
    const second = entryA({ estimate_id: "est_2", tool_use_id: "toolu_second" });
    expect(
      selectReconcilable({
        projectId: projectIdFromCwd(cwd, home),
        entries: [first, second],
        excludeEstimateId: "est_new",
        currentSessionId: SESSION_B,
        nowMs,
      }),
    ).toBeNull();
  });

  it("★ leaves another project's entry alone — it would post under this key", () => {
    // `pending.json` is machine-wide but credentials are not: per-project keys
    // are a documented install path, so closing another project's run here
    // would file it against the wrong account.
    expect(
      selectReconcilable({
        projectId: "0000000000000000",
        entries: [entryA()],
        excludeEstimateId: "est_new",
        currentSessionId: SESSION_B,
        nowMs,
      }),
    ).toBeNull();
  });
});

describe("reconcileEntry — measured from the entry's OWN transcript", () => {
  it("submits session A's counts and trace, read from A's transcript", async () => {
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 1200, output: 3400 });
    const entry = entryA();
    writePending([entry]);

    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "bg_test_dummy",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(outcome).toBe("submitted");
    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.estimateId).toBe("est_A");
    expect(body.tokensIn).toBe(1200);
    expect(body.tokensOut).toBe(3400);
    // The trace is measured from the same transcript by the same parser.
    expect(Array.isArray(body.trace)).toBe(true);
    expect((body.trace as unknown[]).length).toBeGreaterThan(0);
    // Provenance rides from the ENTRY, never re-resolved here.
    expect(body.metadata).toEqual({ source: "mcp_client" });
    // The entry is closed out.
    expect(readPending().entries).toHaveLength(0);
  });

  it("★ stamps success=true, and that is a POLICY not a measurement", async () => {
    // The hook decides `success` from a host-reported termination reason we do
    // not have; its own default for an unknown reason is `false`, which here
    // would stamp a systematic label on every reconciled run rather than a
    // measurement. We submit only for a session whose serving process is gone
    // and whose transcript is complete and stable — a session that ran to
    // termination, which is what the hook counts as success. Pinned so the
    // choice cannot be changed silently.
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 1, output: 2 });
    const entry = entryA();
    writePending([entry]);
    const fake = makeFakeClient();
    await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });
    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.success).toBe(true);
  });

  it("★ submits nothing when two transcripts both carry the tool-use id", async () => {
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 1, output: 2 });
    // A fork/copy: the same host-issued id in a second file. Nothing can be
    // proven, so nothing is submitted — "pick one" would be a guess.
    writeTranscript(dir, SESSION_B, TOOL_USE_A, { input: 900, output: 900 });
    const entry = entryA({ session_id: "cccccccc-1111-4222-8333-444444444444" });
    writePending([entry]);
    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });
    expect(outcome).toBe("no-transcript");
    expect(fake.submitActuals).not.toHaveBeenCalled();
  });

  it("★ refuses a transcript_dir that is not one of Claude Code's own", async () => {
    // `pending.json` is an ordinary file in a home directory this server's own
    // host can be talked into writing. A doctored entry must not be able to aim
    // the reader anywhere else.
    const evil = mkdtempSync(join(tmpdir(), "budgetary-evil-"));
    writeFileSync(join(evil, `${SESSION_A}.jsonl`), `secret ${TOOL_USE_A}\n`);
    const entry = entryA({ transcript_dir: evil });
    writePending([entry]);
    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });
    expect(outcome).toBe("no-transcript");
    expect(fake.submitActuals).not.toHaveBeenCalled();
    rmSync(evil, { recursive: true, force: true });
  });

  it("★ refuses a transcript that does not carry this run's tool-use id", async () => {
    const dir = transcriptDir();
    // Session A's transcript exists, but it records a DIFFERENT call — this is
    // the post-`/clear` shape, where the entry's stored session id names an
    // earlier conversation than the one that actually made the estimate.
    writeTranscript(dir, SESSION_A, "toolu_someone_else", { input: 9, output: 9 });
    const entry = entryA();
    writePending([entry]);

    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(outcome).toBe("no-transcript");
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending().entries).toHaveLength(1);
  });

  it("★ finds the run's transcript even when the stored session id is stale", async () => {
    const dir = transcriptDir();
    // The entry says session A (the id the MCP server was spawned with), but the
    // call was actually made after a `/clear`, in session B. The tool-use id is
    // what resolves it.
    writeTranscript(dir, SESSION_A, "toolu_before_clear", { input: 5, output: 5 });
    writeTranscript(dir, SESSION_B, TOOL_USE_A, { input: 777, output: 888 });
    const entry = entryA();
    writePending([entry]);

    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(outcome).toBe("submitted");
    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.tokensIn).toBe(777);
    expect(body.tokensOut).toBe(888);
  });

  it("★ submits nothing when the transcript changes while it is being read", async () => {
    const dir = transcriptDir();
    const path = writeTranscript(dir, SESSION_A, TOOL_USE_A, {
      input: 100,
      output: 200,
    });
    const entry = entryA();
    writePending([entry]);

    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
      // Simulate the session appending mid-read: the reader returns totals for
      // what it saw, and the post-read fingerprint no longer matches.
      readUsage: (p) => {
        const seen = transcriptModule.readTranscriptUsage(p, {});
        appendFileSync(
          path,
          `${JSON.stringify({
            type: "assistant",
            message: { id: "msg_2", usage: { input_tokens: 5000, output_tokens: 9000 } },
          })}\n`,
        );
        return seen;
      },
    });

    expect(outcome).toBe("transcript-changed");
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending().entries).toHaveLength(1);
  });

  it("submits nothing when the transcript has no usable totals", async () => {
    const dir = transcriptDir();
    writeFileSync(
      join(dir, `${SESSION_A}.jsonl`),
      `${JSON.stringify({ type: "user", note: TOOL_USE_A })}\n`,
    );
    const entry = entryA();
    writePending([entry]);

    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(outcome).toBe("no-usage");
    expect(fake.submitActuals).not.toHaveBeenCalled();
    expect(readPending().entries).toHaveLength(1);
  });

  it("derives duration from the transcript's last write, not the reconciling clock", async () => {
    const dir = transcriptDir();
    const path = writeTranscript(dir, SESSION_A, TOOL_USE_A, {
      input: 10,
      output: 20,
    });
    // A short run that happened almost a day ago: the estimate and the session's
    // last write are 30 s apart, and "now" is ~24 h later. Reusing the
    // submitting process's clock (as the hook path may, because for the hook
    // `now` genuinely IS session end) would report a full day as the run's span.
    const createdMs = Date.now() - 24 * 60 * 60 * 1000 + 5_000;
    const endMs = createdMs + 30_000;
    utimesSync(path, new Date(endMs), new Date(endMs));
    const entry = entryA({ created_at: new Date(createdMs).toISOString() });
    writePending([entry]);

    const fake = makeFakeClient();
    await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.durationMs).toBe(30_000);
  });

  it("reports 0 rather than a nonsense span when the transcript predates its estimate", async () => {
    const dir = transcriptDir();
    const path = writeTranscript(dir, SESSION_A, TOOL_USE_A, {
      input: 10,
      output: 20,
    });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(path, old, old);
    const entry = entryA({ created_at: new Date().toISOString() });
    writePending([entry]);

    const fake = makeFakeClient();
    await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.durationMs).toBe(0);
  });

  it("resubmits counts persisted by an earlier failed submit, without re-reading", async () => {
    const dir = transcriptDir();
    // A transcript exists with different numbers; the persisted counts must win.
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 1, output: 2 });
    const entry = entryA({
      tokens_in: 4242,
      tokens_out: 8484,
      success: true,
      duration_ms: 1234,
    });
    writePending([entry]);

    const spy = vi.spyOn(transcriptModule, "readTranscriptUsage");
    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });
    spy.mockRestore();

    expect(outcome).toBe("submitted");
    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.tokensIn).toBe(4242);
    expect(body.tokensOut).toBe(8484);
  });
});

describe("the two race orderings against the session-end hook", () => {
  it("reconcile LOSES: the hook already closed the entry — no double-count, no error", async () => {
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 10, output: 20 });
    const entry = entryA();
    // The hook got there first: the entry is already gone from the store.
    writePending([]);

    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    // The POST is a no-op by contract (idempotent on estimate_id, first wins).
    expect(outcome).toBe("submitted");
    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    // Locally nothing double-counts: the store still holds exactly zero entries.
    expect(readPending().entries).toHaveLength(0);
  });

  it("reconcile WINS: the entry is removed, so nothing is left to submit twice", async () => {
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 10, output: 20 });
    const entry = entryA();
    writePending([entry]);

    const fake = makeFakeClient();
    await reconcileEntry({
      entry,
      apiKey: "k",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(readPending().entries).toHaveLength(0);
    // A hook firing afterwards finds no pending entry for this estimate and has
    // nothing to send — exactly one actual either way.
    expect(
      readPending().entries.find((e) => e.estimate_id === "est_A"),
    ).toBeUndefined();
  });
});

describe("the estimate path is untouched", () => {
  function estimateUnder(env: NodeJS.ProcessEnv, fake: FakeClient, toolUseId?: string) {
    return runEstimateTool({
      query: "do a thing",
      env,
      cwd,
      home,
      clientFactory: () => asClient(fake),
      ...(toolUseId !== undefined ? { toolUseId } : {}),
    });
  }

  it("stamps the session binding on the new entry when the host supplies one", async () => {
    transcriptDir();
    const fake = makeFakeClient();
    const result = await estimateUnder(
      { ...ENV_KEY, [SESSION_ID_ENV]: SESSION_B, [PROJECT_DIR_ENV]: cwd },
      fake,
      TOOL_USE_B,
    );
    expect(result.isError).toBe(false);
    const stored = readPending().entries[0]!;
    expect(stored.session_id).toBe(SESSION_B);
    expect(stored.tool_use_id).toBe(TOOL_USE_B);
    expect(stored.owner_pid).toBe(process.pid);
    expect(stored.transcript_dir).toBe(
      join(home, ".claude", "projects", claudeProjectSlug(cwd)),
    );
  });

  it("stamps NO binding fields on a host that supplies none", async () => {
    const fake = makeFakeClient();
    await estimateUnder(ENV_KEY, fake);
    const stored = readPending().entries[0]!;
    expect(stored.session_id).toBeUndefined();
    expect(stored.tool_use_id).toBeUndefined();
    expect(stored.transcript_dir).toBeUndefined();
    expect(stored.owner_pid).toBeUndefined();
  });

  it("★ reads no transcript at all when there is nothing to reconcile", async () => {
    transcriptDir();
    const spy = vi.spyOn(transcriptModule, "readTranscriptUsage");
    const fake = makeFakeClient();
    await estimateUnder(
      { ...ENV_KEY, [SESSION_ID_ENV]: SESSION_B, [PROJECT_DIR_ENV]: cwd },
      fake,
      TOOL_USE_B,
    );
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(fake.submitActuals).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("★ reads no transcript when the only candidate is this session's own entry", async () => {
    transcriptDir();
    writeTranscript(
      join(home, ".claude", "projects", claudeProjectSlug(cwd)),
      SESSION_A,
      TOOL_USE_A,
      { input: 1, output: 1 },
    );
    // DEAD pid on purpose: the liveness gate would let this through, so only
    // the session gate can exclude it. With `process.pid` here the test would
    // pass even if the session gate were deleted.
    writePending([entryA()]);
    const spy = vi.spyOn(transcriptModule, "readTranscriptUsage");
    const fake = makeFakeClient();
    // Same session id as the pending entry: this is the session that wrote it.
    await estimateUnder(
      { ...ENV_KEY, [SESSION_ID_ENV]: SESSION_A, [PROJECT_DIR_ENV]: cwd },
      fake,
      TOOL_USE_B,
    );
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(fake.submitActuals).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("★ end to end: session A finished, session B estimates, A's actual lands", async () => {
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 3210, output: 6540 });
    writePending([entryA()]);

    const spy = vi.spyOn(transcriptModule, "readTranscriptUsage");
    const fake = makeFakeClient();
    const result = await estimateUnder(
      { ...ENV_KEY, [SESSION_ID_ENV]: SESSION_B, [PROJECT_DIR_ENV]: cwd },
      fake,
      TOOL_USE_B,
    );
    // B's own estimate is returned normally, with no mention of any of this.
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("reconcil");

    // ★ The estimate has RESOLVED and nothing has been read or posted yet — the
    // reconcile is scheduled for a later turn of the event loop, so the MCP SDK
    // has already serialized and sent this result. This is the direct evidence
    // that the interactive path is never delayed by any of the work below.
    expect(spy).not.toHaveBeenCalled();
    expect(fake.submitActuals).not.toHaveBeenCalled();

    await flush();

    // ...and afterwards it did run — which also proves the `not.toHaveBeenCalled`
    // assertions elsewhere in this file are meaningful rather than vacuous.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.estimateId).toBe("est_A");
    expect(body.tokensIn).toBe(3210);
    expect(body.tokensOut).toBe(6540);
    // A's entry is closed; B's own entry remains open.
    const ids = readPending().entries.map((e) => e.estimate_id);
    expect(ids).toEqual(["est_new"]);
  });

  it("★ a reconcile failure is invisible to the estimate", async () => {
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 10, output: 20 });
    writePending([entryA()]);

    const fake = makeFakeClient();
    fake.submitActuals.mockImplementation(async () => {
      throw new Error("network down");
    });

    const result = await estimateUnder(
      { ...ENV_KEY, [SESSION_ID_ENV]: SESSION_B, [PROJECT_DIR_ENV]: cwd },
      fake,
      TOOL_USE_B,
    );
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("couldn't be reached");
    await flush();
    // A's entry survives for a later estimate, with its attempt counted.
    const a = readPending().entries.find((e) => e.estimate_id === "est_A");
    expect(a?.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// censoring (0099a-1): the reconcile runs on the NEXT estimate, in a different
// process, against a PREVIOUS session's entry and transcript. It observed
// nothing about that run's ending, so it sends nothing — pinned here because
// an absent key is only an invariant if something checks for it.
// ---------------------------------------------------------------------------

describe("censoring — the reconcile sends NOTHING it did not observe", () => {
  it("★★ a fresh reconcile emits no censoring key and no cap key, ever", async () => {
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 1200, output: 3400 });
    const entry = entryA();
    writePending([entry]);

    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "bg_test_dummy",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(outcome).toBe("submitted");
    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect("censoring" in body).toBe(false);
    for (const k of ["cap_ms", "capMs", "cap_tokens", "capTokens"]) {
      expect(k in body).toBe(false);
    }
    expect(JSON.stringify(body)).not.toMatch(/censoring|cap_ms|capMs|cap_tokens|capTokens/);
  });

  it("a declaration PERSISTED by an earlier failed submit still rides its retry here", async () => {
    // Not a reconcile observation: the original declaring submit persisted the
    // category beside its measured counts, and the reconcile — like every
    // retry — resubmits exactly what was persisted, because the retry is the
    // first submission that stores the row.
    const dir = transcriptDir();
    writeTranscript(dir, SESSION_A, TOOL_USE_A, { input: 1, output: 2 });
    const entry = entryA({
      tokens_in: 4242,
      tokens_out: 8484,
      success: false,
      duration_ms: 1234,
      censoring: "harness_watchdog",
    });
    writePending([entry]);

    const fake = makeFakeClient();
    const outcome = await reconcileEntry({
      entry,
      apiKey: "bg_test_dummy",
      baseUrl: "https://api.example.test",
      env: {} as NodeJS.ProcessEnv,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(outcome).toBe("submitted");
    const body = fake.submitActuals.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.censoring).toBe("harness_watchdog");
    expect(body.tokensIn).toBe(4242);
  });
});
