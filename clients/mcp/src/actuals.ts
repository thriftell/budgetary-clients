import {
  BudgetaryClient,
  BudgetaryError,
  type BudgetaryClientOptions,
} from "@budgetary/sdk";

import {
  noKeyGuidance,
  pendingFilePath,
  resolveConfig,
  resolveConfigStatus,
  traceTargetEnabled,
} from "./config.js";
import { PendingStore, type PendingEntry, type PendingStoreFile } from "./store.js";
import { projectIdFromCwd } from "./tools/estimate.js";
import {
  capTrace,
  readTranscriptUsage,
  type ReadUsageOptions,
  type TraceStep,
  type TranscriptUsage,
} from "./transcript.js";

export const MAX_ATTEMPTS = 5;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Realized counts for a completed run. These are ALWAYS supplied by the
 * caller — either a session-end hook reading the real transcript, or a human
 * typing them into the `report-actual` CLI. There is deliberately no code
 * path that lets a language model populate these: a fabricated actual poisons
 * calibration and is worse than none.
 */
export interface ActualCounts {
  tokensIn: number;
  tokensOut: number;
  success: boolean;
  durationMs: number;
  /**
   * Optional measured execution trace, forwarded additively on the same POST.
   * Populated ONLY by the auto path from a real transcript (already capped and
   * fail-closed). The manual path leaves it undefined — there is no transcript
   * to measure, and a model never supplies it.
   */
  trace?: TraceStep[];
}

/**
 * The minimal store surface {@link submitActuals} needs. Typed structurally
 * (not as the concrete {@link PendingStore}) so first-party clients can pass
 * their own byte-compatible store instance across the package boundary. Both
 * `read` and `write` are required: the submit path re-reads immediately before
 * writing so a concurrent append during the network round-trip is not lost.
 */
export interface PendingWriter {
  read(): PendingStoreFile;
  write(file: PendingStoreFile): void;
}

export interface SubmitActualsArgs {
  store: PendingWriter;
  client: BudgetaryClient;
  /** The entry being closed out, identified by its `estimate_id`. */
  entry: PendingEntry;
  /** Caller-supplied realized counts. Never derived from a model. */
  counts: ActualCounts;
  logger?: { warn(message: string): void };
}

/** Drop the entry with this `estimate_id` from `file`; returns whether it was present. */
function removeById(file: PendingStoreFile, estimateId: string): boolean {
  const idx = file.entries.findIndex((e) => e.estimate_id === estimateId);
  if (idx === -1) return false;
  file.entries.splice(idx, 1);
  return true;
}

/** The outcome of one {@link submitActuals} call, so callers can report it honestly. */
export interface SubmitOutcome {
  /** THIS call's POST succeeded and the entry was removed. */
  submitted: boolean;
  /**
   * When not submitted, whether a later attempt could plausibly succeed —
   * `true` for network / 5xx / 429, `false` for a 4xx the server rejected. A
   * caller must NOT advise retrying a non-retryable rejection.
   */
  retryable: boolean;
  /**
   * When not submitted and not retryable: `true` iff the rejection is TERMINAL
   * (400/404/409/413/… — it will never succeed) and the entry was DROPPED so it
   * can't head-of-line-block the queue; `false` iff it is user-fixable (401/403 —
   * fixing the key/plan lets the same submit succeed) and the entry was KEPT.
   */
  terminal: boolean;
  /** True iff attempts reached {@link MAX_ATTEMPTS} and the entry was dropped (already warned). */
  gaveUp: boolean;
  /** The error that prevented submission, for honest reporting. Never carries the key. */
  error?: unknown;
}

/**
 * Whether a failed submit could plausibly succeed on a later attempt. The SDK
 * already retries 5xx/429 internally; by the time an error reaches here it is
 * either a transient network failure, an exhausted-retry 5xx/429, or a 4xx the
 * server deliberately rejected. Only the former are worth another attempt.
 */
function isRetryableSubmitError(err: unknown): boolean {
  if (err instanceof BudgetaryError) {
    const s = err.httpStatus;
    return s === null || s >= 500 || s === 429;
  }
  // A non-Budgetary (unexpected) error is treated as transient.
  return true;
}

/**
 * A 4xx rejection a user CAN fix so the SAME submit later succeeds — a rejected
 * key (401) or a key without an active plan (403). Every other 4xx is terminal:
 * re-submitting the same estimate will never work, so it must not be kept (it
 * would pin the newest-entry queue forever with no cleanup on the manual paths).
 */
function isUserFixableRejection(err: unknown): boolean {
  if (err instanceof BudgetaryError) {
    return err.httpStatus === 401 || err.httpStatus === 403;
  }
  return false;
}

/**
 * The single submit path shared by the auto (hook), manual, and rollout flows.
 *
 * On success: remove the entry. On failure: increment `attempts`, and after
 * {@link MAX_ATTEMPTS} drop the entry and log one warning. This is the only
 * function in the package that calls `client.submitActuals`, and it requires
 * the counts to be passed in explicitly. Returns a {@link SubmitOutcome} so a
 * foreground caller can report exactly what happened — success, a retryable
 * transport failure, or a non-retryable rejection — instead of inferring it
 * from the entry's presence (which a concurrent close could make a lie).
 *
 * The store is RE-READ immediately before every mutation, and the target is
 * located by `estimate_id` (never by position): `client.submitActuals` takes
 * seconds, during which another session may have appended or removed an entry.
 * Writing back a pre-read snapshot, or popping the last element, would lose that
 * concurrent work or close the wrong entry.
 */
export async function submitActuals(
  args: SubmitActualsArgs,
): Promise<SubmitOutcome> {
  const { store, client, entry, counts } = args;
  const logger = args.logger ?? { warn: () => {} };

  try {
    await client.submitActuals({
      estimateId: entry.estimate_id,
      tokensIn: counts.tokensIn,
      tokensOut: counts.tokensOut,
      success: counts.success,
      durationMs: counts.durationMs,
      // Additive: only sent when the caller measured a non-empty trace.
      ...(counts.trace && counts.trace.length > 0
        ? { trace: counts.trace }
        : {}),
    });
    const fresh = store.read();
    if (removeById(fresh, entry.estimate_id)) store.write(fresh);
    return { submitted: true, retryable: false, terminal: false, gaveUp: false };
  } catch (err) {
    const retryable = isRetryableSubmitError(err);
    const fresh = store.read();
    const idx = fresh.entries.findIndex(
      (e) => e.estimate_id === entry.estimate_id,
    );
    // Already closed by another path — THIS call did not submit; say so.
    if (idx === -1)
      return { submitted: false, retryable, terminal: false, gaveUp: false, error: err };
    if (!retryable) {
      if (isUserFixableRejection(err)) {
        // 401/403: fixing the key/plan lets the SAME submit succeed. Keep the
        // entry (don't count it toward give-up); the user resubmits after fixing.
        return { submitted: false, retryable: false, terminal: false, gaveUp: false, error: err };
      }
      // A terminal 4xx (400/404/409/413/…) will never succeed. DROP it so it
      // can't head-of-line-block this project's queue — the manual/rollout paths
      // always act on the newest matching entry and have no TTL cleanup.
      fresh.entries.splice(idx, 1);
      store.write(fresh);
      return { submitted: false, retryable: false, terminal: true, gaveUp: false, error: err };
    }
    const current = fresh.entries[idx]!;
    const updated: PendingEntry = {
      ...current,
      attempts: current.attempts + 1,
    };
    if (updated.attempts >= MAX_ATTEMPTS) {
      fresh.entries.splice(idx, 1);
      store.write(fresh);
      const detail = err instanceof BudgetaryError ? err.message : String(err);
      logger.warn(
        `Budgetary: giving up on actuals for ${entry.estimate_id} after ${MAX_ATTEMPTS} attempts (${detail}).`,
      );
      return { submitted: false, retryable, terminal: false, gaveUp: true, error: err };
    }
    fresh.entries[idx] = updated;
    store.write(fresh);
    return { submitted: false, retryable, terminal: false, gaveUp: false, error: err };
  }
}

/** The newest pending entry belonging to `projectId`, or null if none match. */
function newestForProject(
  entries: readonly PendingEntry[],
  projectId: string | null,
): PendingEntry | null {
  if (projectId === null) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.project_id === projectId) return entries[i]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auto path: a session-end hook reading the real transcript (Claude Code/Codex)
// ---------------------------------------------------------------------------

export interface SessionEndPayload {
  transcript_path?: string;
  reason?: string;
  started_at?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface AutoActualsArgs {
  payload: SessionEndPayload | null;
  env: NodeJS.ProcessEnv;
  home?: string;
  /**
   * The ending session's working directory, hashed to the same `project_id`
   * the estimate stored. Used to bind an actual to its own session's estimate;
   * falls back to `payload.cwd` when omitted.
   */
  cwd?: string;
  now?: () => Date;
  stderr: { write(s: string): void };
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
  /** Override transcript-usage reader (tests). */
  readUsage?: (path: string, options?: ReadUsageOptions) => TranscriptUsage | null;
}

/** This session's project id from its cwd (arg or payload), or null if unknown. */
function sessionProjectId(args: AutoActualsArgs): string | null {
  const cwd =
    args.cwd ??
    (args.payload && typeof args.payload.cwd === "string"
      ? args.payload.cwd
      : undefined);
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  return projectIdFromCwd(cwd);
}

/**
 * Close out THIS session's newest pending estimate from real session usage.
 * The entry is bound to the session by `project_id` (derived from the session's
 * cwd), so an actual is never mis-paired to a different concurrent session's
 * estimate. Submits nothing unless the transcript yields token counts; drops a
 * matched entry older than 24h silently. Routes the submit through
 * {@link submitActuals}.
 */
export async function runAutoActuals(args: AutoActualsArgs): Promise<number> {
  const store = new PendingStore({
    path: pendingFilePath(args.home),
    logger: { warn: (m) => args.stderr.write(`${m}\n`) },
  });
  const file = store.read();
  if (file.entries.length === 0) return 0;

  // Bind to this session's own estimate; leave other sessions' entries alone.
  const entry = newestForProject(file.entries, sessionProjectId(args));
  if (entry === null) return 0;

  const now = (args.now ?? (() => new Date()))();
  const created = Date.parse(entry.created_at);
  if (!Number.isFinite(created) || now.getTime() - created > PENDING_TTL_MS) {
    // Drop just this stale entry (by id, re-reading first); leave the rest.
    const fresh = store.read();
    if (removeById(fresh, entry.estimate_id)) store.write(fresh);
    return 0;
  }

  if (args.payload === null) return 0;
  const transcriptPath =
    typeof args.payload.transcript_path === "string"
      ? args.payload.transcript_path
      : null;
  if (transcriptPath === null) return 0;

  // Honor the privacy opt-out: when trace detail is suppressed, the redacted
  // `target` is omitted (the trace keeps tool/tokens/kind and the leak-free
  // `ok`); the realized total is unaffected either way.
  const usage = (args.readUsage ?? readTranscriptUsage)(transcriptPath, {
    target: traceTargetEnabled(args.env),
  });
  if (usage === null) return 0; // no real counts → submit nothing

  const resolved = resolveConfig(args.env, args.home);
  if (resolved === null) return 0; // leave the entry for a later session with a key

  const factory =
    args.clientFactory ??
    ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  const client = factory({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });

  // Fail-closed: an over-cap or empty trace becomes `undefined`, so the total
  // still submits with no `trace` rather than failing or shipping invented steps.
  const trace = capTrace(usage.trace) ?? undefined;

  await submitActuals({
    store,
    client,
    entry,
    counts: {
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      success: isSuccessReason(args.payload.reason),
      durationMs: inferDurationMs(args.payload, entry, now),
      ...(trace ? { trace } : {}),
    },
    logger: { warn: (m) => args.stderr.write(`${m}\n`) },
  });
  return 0;
}

function isSuccessReason(reason: unknown): boolean {
  // Conservative: only documented "normal" terminations count as success.
  return (
    reason === "clear" || reason === "logout" || reason === "prompt_input_exit"
  );
}

function inferDurationMs(
  payload: SessionEndPayload,
  pending: PendingEntry,
  now: Date,
): number {
  const startMs =
    typeof payload.started_at === "string"
      ? Date.parse(payload.started_at)
      : NaN;
  if (Number.isFinite(startMs)) return Math.max(0, now.getTime() - startMs);
  const createdMs = Date.parse(pending.created_at);
  if (Number.isFinite(createdMs)) return Math.max(0, now.getTime() - createdMs);
  return 0;
}

// ---------------------------------------------------------------------------
// Manual path: a human enters counts (`report-actual`)
// ---------------------------------------------------------------------------

export interface ManualActualsArgs {
  env: NodeJS.ProcessEnv;
  home?: string;
  /**
   * Session cwd, hashed to scope to THIS project's newest pending estimate so a
   * concurrent project's estimate is never closed by mistake. Omit → the
   * globally-newest entry (back-compat).
   */
  cwd?: string;
  /** Write a line to the user. */
  out: (line: string) => void;
  /** Ask the user a question and return their (trimmed) answer. */
  prompt: (question: string) => Promise<string>;
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
}

const QUERY_EXCERPT_LEN = 120;
const MAX_PROMPT_TRIES = 3;

/**
 * Prompt a human for the realized counts of the current project's newest pending
 * estimate and submit them. Used by hosts that do not expose run token usage.
 * The API key is checked BEFORE prompting (don't make the user type counts only
 * to learn there is no key); grouped numbers like `48,000` are accepted and
 * invalid input is re-prompted; the failure cause is surfaced honestly and a
 * user-fixable rejection leaves the estimate pending rather than dropping it.
 */
export async function runManualActuals(args: ManualActualsArgs): Promise<number> {
  const host = args.env.BUDGETARY_HOST;

  // Check the key first — before any prompting.
  const status = resolveConfigStatus(args.env, args.home);
  if (status.kind !== "ok") {
    args.out(
      noKeyGuidance(host, status.kind === "unreadable" ? "unreadable" : "no-key"),
    );
    return 1;
  }
  const resolved = status.config;

  const store = new PendingStore({
    path: pendingFilePath(args.home),
    logger: { warn: args.out },
  });
  const file = store.read();
  if (file.entries.length === 0) {
    args.out("No pending Budgetary estimate to report.");
    return 0;
  }

  const entry =
    args.cwd !== undefined
      ? newestForProject(file.entries, projectIdFromCwd(args.cwd))
      : file.entries[file.entries.length - 1]!;
  if (entry === null) {
    args.out("No pending Budgetary estimate for this project directory.");
    args.out(
      `(${file.entries.length} pending for other ${
        file.entries.length === 1 ? "project" : "projects"
      } — run report-actual from the directory you estimated in.)`,
    );
    return 0;
  }

  const excerpt = entry.query.slice(0, QUERY_EXCERPT_LEN);
  args.out("Reporting actuals for this estimate:");
  args.out(`  ${excerpt}${entry.query.length > QUERY_EXCERPT_LEN ? "…" : ""}`);
  args.out("");

  const tokensIn = await promptNonNegInt(args, "Input tokens (tokens_in): ", "tokens_in", false);
  if (tokensIn === null) return 2;
  const tokensOut = await promptNonNegInt(args, "Output tokens (tokens_out): ", "tokens_out", false);
  if (tokensOut === null) return 2;
  const success = parseBool(await args.prompt("Did the task succeed? [y/N]: "));
  if (success === null) {
    args.out("Please answer y or n. Nothing submitted.");
    return 2;
  }
  const durationMs = await promptNonNegInt(args, "Duration in ms (optional): ", "duration_ms", true);
  if (durationMs === null) return 2;

  const factory =
    args.clientFactory ??
    ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  const client = factory({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });

  const outcome = await submitActuals({
    store,
    client,
    entry,
    counts: { tokensIn, tokensOut, success, durationMs },
    logger: { warn: args.out },
  });

  if (outcome.submitted) {
    args.out("Actuals submitted. Thanks — this calibrates future estimates.");
    return 0;
  }
  if (outcome.gaveUp) {
    // submitActuals already printed the give-up warning via the logger.
    return 1;
  }
  const detail = outcome.error instanceof Error ? outcome.error.message : "";
  if (outcome.retryable) {
    args.out(
      `Couldn't reach Budgetary${detail ? ` (${detail})` : ""}; the estimate is ` +
        "still pending. Try again later.",
    );
  } else if (outcome.terminal) {
    args.out(
      `Budgetary rejected this submission${detail ? `: ${detail}` : ""}. It can't ` +
        "succeed, so the estimate has been discarded.",
    );
  } else {
    args.out(
      `Budgetary rejected this submission${detail ? `: ${detail}` : ""}. Fix your ` +
        "API key or plan, then resubmit — the estimate is left pending.",
    );
  }
  return 1;
}

/**
 * Prompt for a non-negative whole number, accepting grouped input (`48,000`)
 * and re-prompting up to {@link MAX_PROMPT_TRIES} times on invalid input. An
 * `optional` field returns 0 on an empty answer; a required field that stays
 * invalid returns `null` (the caller aborts).
 */
async function promptNonNegInt(
  args: Pick<ManualActualsArgs, "prompt" | "out">,
  question: string,
  label: string,
  optional: boolean,
): Promise<number | null> {
  for (let i = 0; i < MAX_PROMPT_TRIES; i++) {
    const raw = (await args.prompt(question)).trim();
    if (optional && raw.length === 0) return 0;
    const n = parseNonNegInt(raw);
    if (n !== null) return n;
    if (i < MAX_PROMPT_TRIES - 1) {
      args.out(
        `${label} must be a non-negative whole number (commas OK, e.g. 48,000). Try again.`,
      );
    }
  }
  args.out(`${label} must be a non-negative whole number. Nothing submitted.`);
  return null;
}

function parseNonNegInt(raw: string): number | null {
  const trimmed = raw.trim();
  // Plain digits, or WELL-FORMED 3-digit groups ("48,000" / "48 000" /
  // "1_000_000"). A malformed group ("1,2,3", "48,00") is rejected rather than
  // silently coerced — never fabricate a count from ambiguous input.
  const grouped = /^\d{1,3}([,_ ]\d{3})+$/.test(trimmed);
  if (!/^\d+$/.test(trimmed) && !grouped) return null;
  const n = Number(trimmed.replace(/[,_ ]/g, ""));
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Rollout path: a human runs `on-session-end --transcript <path>` after a Codex
// (or any) session to submit REAL, transcript-derived counts. Unlike the auto
// hook path this is a foreground command, so it reports its outcome loudly —
// what it submitted, or exactly why it didn't. Unlike the manual `report-actual`
// path it reads the counts from the transcript rather than prompting, so a human
// never types (and never fabricates) a token number.
// ---------------------------------------------------------------------------

export interface RolloutActualsArgs {
  /** Path to the rollout / transcript JSONL file to read real counts from. */
  transcriptPath: string;
  /**
   * Whether the run completed its objective. The transcript carries real token
   * counts but not a trustworthy success signal, so the human supplies it
   * (default true; `--failed` sets it false). This is the ONLY caller-declared
   * field — the token counts are always measured, never entered.
   */
  success: boolean;
  env: NodeJS.ProcessEnv;
  home?: string;
  /** The session's working directory, hashed to bind the actual to its own project. */
  cwd: string;
  now?: () => Date;
  /** Write a line to the user. */
  out: (line: string) => void;
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
  /** Override transcript-usage reader (tests). */
  readUsage?: (path: string, options?: ReadUsageOptions) => TranscriptUsage | null;
}

/**
 * Submit actuals for THIS project's newest pending estimate from a real session
 * transcript. Binds by `project_id` (the cwd hash) so it never closes another
 * project's estimate, reuses the shared concurrency-safe {@link submitActuals},
 * reports every outcome, and never exits 0 having silently done nothing.
 * Returns a process exit code.
 */
export async function runRolloutActuals(
  args: RolloutActualsArgs,
): Promise<number> {
  const store = new PendingStore({
    path: pendingFilePath(args.home),
    logger: { warn: args.out },
  });
  const file = store.read();
  if (file.entries.length === 0) {
    args.out("No pending Budgetary estimate to report.");
    return 0;
  }

  const entry = newestForProject(file.entries, projectIdFromCwd(args.cwd));
  if (entry === null) {
    args.out("No pending Budgetary estimate for this project directory.");
    args.out(
      `(${file.entries.length} pending for other ${
        file.entries.length === 1 ? "project" : "projects"
      } — run this from the directory you estimated in, or use ` +
        "`npx @budgetary/mcp report-actual`.)",
    );
    return 0;
  }

  // Check the key before reading the transcript: without one nothing can be
  // submitted, so surface that first rather than after the work.
  const resolved = resolveConfig(args.env, args.home);
  if (resolved === null) {
    args.out(noKeyGuidance());
    return 1;
  }

  const usage = (args.readUsage ?? readTranscriptUsage)(args.transcriptPath, {
    target: traceTargetEnabled(args.env),
  });
  if (usage === null) {
    args.out(
      `No token totals found in ${args.transcriptPath} — nothing submitted.`,
    );
    args.out(
      "Budgetary reads Codex rollout `token_count` events and Claude Code " +
        "transcripts; an unrecognized or empty file yields nothing (never a " +
        "guessed count).",
    );
    return 1;
  }

  const factory =
    args.clientFactory ??
    ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  const client = factory({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });

  const now = (args.now ?? (() => new Date()))();
  // Fail-closed: an empty/over-cap trace becomes undefined and only the totals
  // submit. A Codex rollout always yields an empty trace (no per-tool data).
  const trace = capTrace(usage.trace) ?? undefined;

  // The submit reports its own outcome, so success is asserted from THIS call —
  // never inferred from the entry's absence (a concurrent close could make that
  // a lie) — and a non-retryable rejection is never dressed up as "try again".
  const outcome = await submitActuals({
    store,
    client,
    entry,
    counts: {
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      success: args.success,
      durationMs: inferDurationMs({}, entry, now),
      ...(trace ? { trace } : {}),
    },
    logger: { warn: args.out },
  });

  if (outcome.submitted) {
    const commas = (n: number) => n.toLocaleString("en-US");
    args.out(
      `Actuals submitted: ${commas(usage.tokensIn)} in / ${commas(usage.tokensOut)} out, ` +
        `recorded as ${args.success ? "successful" : "failed"}. ` +
        "Thanks — this calibrates future estimates.",
    );
    if (args.success) {
      args.out("(Re-run with `--failed` if the task didn't actually complete.)");
    }
    return 0;
  }
  if (outcome.gaveUp) {
    // submitActuals already printed the give-up warning via the logger.
    return 1;
  }
  const detail =
    outcome.error instanceof Error ? outcome.error.message : "";
  if (outcome.retryable) {
    args.out(
      `Couldn't reach Budgetary${detail ? ` (${detail})` : ""}; the estimate is ` +
        "still pending. Resubmit after the next session or with `report-actual`.",
    );
  } else if (outcome.terminal) {
    args.out(
      `Budgetary rejected this submission${detail ? `: ${detail}` : ""}. It can't ` +
        "succeed, so the estimate has been discarded.",
    );
  } else {
    args.out(
      `Budgetary rejected this submission${detail ? `: ${detail}` : ""}. Fix your ` +
        "API key or plan, then resubmit — the estimate is left pending.",
    );
  }
  return 1;
}

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "y" || v === "yes" || v === "true") return true;
  if (v === "n" || v === "no" || v === "false" || v === "") return false;
  return null;
}

// ---------------------------------------------------------------------------
// Status: `pending` — surface estimates whose actuals were never captured.
// Read-only; no server call. This is how a lost actual becomes visible.
// ---------------------------------------------------------------------------

export interface PendingListArgs {
  env: NodeJS.ProcessEnv;
  home?: string;
  /** Marks entries belonging to the current project. */
  cwd?: string;
  now?: () => Date;
  out: (line: string) => void;
}

/** A short human age like "just now", "3h ago", "2d ago". */
function describeAge(createdAt: string, now: Date): string {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return "unknown age";
  const ms = now.getTime() - created;
  if (ms < 60 * 1000) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * List pending estimates awaiting actuals, newest first, marking those for the
 * current project. Never fabricates or submits anything — it only reads the
 * local store so an un-recorded run is visible instead of silently lost.
 */
export function runPendingList(args: PendingListArgs): number {
  const store = new PendingStore({
    path: pendingFilePath(args.home),
    logger: { warn: args.out },
  });
  const entries = store.read().entries;
  if (entries.length === 0) {
    args.out("No pending Budgetary estimates — the loop is closed.");
    return 0;
  }

  const now = (args.now ?? (() => new Date()))();
  const projectId =
    args.cwd !== undefined ? projectIdFromCwd(args.cwd) : null;
  const sorted = [...entries].sort((a, b) => {
    const ta = Date.parse(a.created_at);
    const tb = Date.parse(b.created_at);
    return (Number.isFinite(tb) ? tb : -Infinity) - (Number.isFinite(ta) ? ta : -Infinity);
  });

  args.out(
    `${entries.length} pending Budgetary ${
      entries.length === 1 ? "estimate" : "estimates"
    } awaiting actuals:`,
  );
  for (const e of sorted) {
    const here = projectId !== null && e.project_id === projectId ? " (this project)" : "";
    const excerpt = e.query.slice(0, 60);
    const ellipsis = e.query.length > 60 ? "…" : "";
    args.out(`  • ${excerpt}${ellipsis} — ${describeAge(e.created_at, now)}${here}`);
  }
  args.out("");
  args.out(
    "Close them with `npx @budgetary/mcp report-actual` (or, from a rollout, " +
      "`npx @budgetary/mcp on-session-end --transcript <path>`).",
  );
  return 0;
}
