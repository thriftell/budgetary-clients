import {
  BudgetaryClient,
  BudgetaryError,
  type BudgetaryClientOptions,
} from "@budgetary/sdk";

import {
  noKeyGuidance,
  pendingFilePath,
  resolveConfig,
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

/**
 * The single submit path shared by the auto (hook) and manual (CLI) flows.
 *
 * On success: remove the entry. On failure: increment `attempts`, and after
 * {@link MAX_ATTEMPTS} drop the entry and log one warning. This is the only
 * function in the package that calls `client.submitActuals`, and it requires
 * the counts to be passed in explicitly.
 *
 * The store is RE-READ immediately before every mutation, and the target is
 * located by `estimate_id` (never by position): `client.submitActuals` takes
 * seconds, during which another session may have appended or removed an entry.
 * Writing back a pre-read snapshot, or popping the last element, would lose that
 * concurrent work or close the wrong entry.
 */
export async function submitActuals(args: SubmitActualsArgs): Promise<void> {
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
  } catch (err) {
    const fresh = store.read();
    const idx = fresh.entries.findIndex(
      (e) => e.estimate_id === entry.estimate_id,
    );
    if (idx === -1) return; // already closed (another session, or TTL-dropped)
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
      return;
    }
    fresh.entries[idx] = updated;
    store.write(fresh);
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
  /** Write a line to the user. */
  out: (line: string) => void;
  /** Ask the user a question and return their (trimmed) answer. */
  prompt: (question: string) => Promise<string>;
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
}

const QUERY_EXCERPT_LEN = 120;

/**
 * Prompt a human for the realized counts of the newest pending estimate and
 * submit them. Used by hosts that do not expose run token usage. Rejects
 * non-integer / negative input rather than submitting garbage.
 */
export async function runManualActuals(args: ManualActualsArgs): Promise<number> {
  const store = new PendingStore({ path: pendingFilePath(args.home) });
  const file = store.read();
  if (file.entries.length === 0) {
    args.out("No pending Budgetary estimate to report.");
    return 0;
  }

  const newest = file.entries[file.entries.length - 1]!;
  const excerpt = newest.query.slice(0, QUERY_EXCERPT_LEN);
  args.out(`Reporting actuals for the most recent estimate:`);
  args.out(`  ${excerpt}${newest.query.length > QUERY_EXCERPT_LEN ? "…" : ""}`);
  args.out("");

  const tokensIn = parseNonNegInt(await args.prompt("Input tokens (tokens_in): "));
  if (tokensIn === null) {
    args.out("tokens_in must be a non-negative whole number. Nothing submitted.");
    return 2;
  }
  const tokensOut = parseNonNegInt(
    await args.prompt("Output tokens (tokens_out): "),
  );
  if (tokensOut === null) {
    args.out("tokens_out must be a non-negative whole number. Nothing submitted.");
    return 2;
  }
  const success = parseBool(await args.prompt("Did the task succeed? [y/N]: "));
  if (success === null) {
    args.out("Please answer y or n. Nothing submitted.");
    return 2;
  }
  const durationRaw = (await args.prompt("Duration in ms (optional): ")).trim();
  let durationMs = 0;
  if (durationRaw.length > 0) {
    const parsed = parseNonNegInt(durationRaw);
    if (parsed === null) {
      args.out("duration_ms must be a non-negative whole number. Nothing submitted.");
      return 2;
    }
    durationMs = parsed;
  }

  const resolved = resolveConfig(args.env, args.home);
  if (resolved === null) {
    args.out(noKeyGuidance());
    return 1;
  }

  const factory =
    args.clientFactory ??
    ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  const client = factory({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });

  let warned: string | null = null;
  await submitActuals({
    store,
    client,
    entry: newest,
    counts: { tokensIn, tokensOut, success, durationMs },
    logger: { warn: (m) => (warned = m) },
  });

  if (warned !== null) {
    args.out(warned);
    return 1;
  }
  // submitActuals removes the entry on success; if it is gone, we succeeded.
  if (store.read().entries.some((e) => e.estimate_id === newest.estimate_id)) {
    args.out("Submission failed; the estimate is still pending. Try again later.");
    return 1;
  }
  args.out("Actuals submitted. Thanks — this calibrates future estimates.");
  return 0;
}

function parseNonNegInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "y" || v === "yes" || v === "true") return true;
  if (v === "n" || v === "no" || v === "false" || v === "") return false;
  return null;
}
