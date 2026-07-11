import {
  BudgetaryClient,
  BudgetaryError,
  type BudgetaryClientOptions,
} from "@budgetary/sdk";

import {
  readBreadcrumb,
  writeBreadcrumb,
  type SessionEndBreadcrumb,
} from "./breadcrumb.js";
import {
  debugEnabled,
  looksLikeBudgetaryKey,
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
  transcriptUnreadableReason,
  type ReadUsageOptions,
  type TraceStep,
  type TranscriptUsage,
} from "./transcript.js";

export const MAX_ATTEMPTS = 5;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Retry cap for the NON-INTERACTIVE actuals submit paths (the auto session-end
 * hook, the rollout `on-session-end --transcript`, and the manual
 * `report-actual`). A server outage must not stall the caller — most critically
 * the session-end hook, which runs inside a 30 s host timeout; the SDK's default
 * ladder (4 retries, ~7.5–15 s of backoff sleeps) would burn most of that budget
 * blocking process exit.
 *
 * Set to 0 — NO in-process retry — rather than 1: the SDK honors a `429`
 * `Retry-After` as a floor clamped to 60 s (see the SDK's `withRetry`), and a
 * 429 is a canonical outage response, so even a single retry could sleep past
 * the 30 s budget and get the hook killed mid-wait — exactly the hang this cap
 * exists to prevent. With 0, the path is bounded by the request timeout alone; a
 * failed submit stays pending and is retried on a later session (up to
 * {@link MAX_ATTEMPTS}) — durable cross-session retry, strictly better than
 * blocking exit on in-process sleeps. The interactive `estimate` path
 * deliberately keeps the SDK's full retry ladder — a user waits there for the result.
 */
const UNATTENDED_MAX_RETRIES = 0;

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
 * Persist `file`, degrading to a warning instead of rethrowing. `store.write`
 * rethrows on any fs failure (an immutable/perm-lost `~/.budgetary`, ENOSPC),
 * and every caller here has ALREADY committed to an outcome — most critically
 * the session-end hook, whose contract is to fail closed (exit 0). Letting a
 * write fault escape would crash the host with a raw stack AFTER a successful
 * POST and mis-report a committed submit as a retryable failure. Returns whether
 * the write landed so a caller can note that a queue mutation didn't persist (a
 * leftover entry is reconciled next session by the server's `estimate_id` dedup).
 */
function tryWrite(
  store: PendingWriter,
  file: PendingStoreFile,
  logger: { warn(message: string): void },
): boolean {
  try {
    store.write(file);
    return true;
  } catch (err) {
    logger.warn(
      `Budgetary: could not update the pending store; leaving it as-is. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return false;
  }
}

/**
 * Stamp the measured `counts` onto a kept (failed-submit) entry so a later
 * session's retry resubmits THESE counts. Only scalar totals are persisted; the
 * trace is recorded as a boolean (`has_trace`) and dropped on retry — the totals
 * are what calibration needs, and re-persisting a large trace would bloat the
 * shared store. Preserves every other field (attempts is set by the caller).
 */
function withPersistedCounts(
  entry: PendingEntry,
  counts: ActualCounts,
): PendingEntry {
  return {
    ...entry,
    tokens_in: counts.tokensIn,
    tokens_out: counts.tokensOut,
    success: counts.success,
    duration_ms: counts.durationMs,
    has_trace: !!(counts.trace && counts.trace.length > 0),
  };
}

/**
 * The measured counts persisted on a prior FAILED submit, or `null` when the
 * entry is fresh (never submitted) or its persisted fields are absent/corrupt.
 * Re-validates every field so a partial/garbage write is ignored (fall back to a
 * fresh read) rather than submitting a fabricated count — the store keeps v1
 * files readable precisely because these are checked here, not trusted on read.
 */
function persistedCounts(entry: PendingEntry): ActualCounts | null {
  const { tokens_in, tokens_out, success, duration_ms } = entry;
  if (
    typeof tokens_in !== "number" ||
    !Number.isSafeInteger(tokens_in) ||
    typeof tokens_out !== "number" ||
    !Number.isSafeInteger(tokens_out) ||
    typeof success !== "boolean" ||
    typeof duration_ms !== "number" ||
    !Number.isFinite(duration_ms)
  ) {
    return null;
  }
  // Retry sends totals only — the original trace was intentionally not persisted.
  return { tokensIn: tokens_in, tokensOut: tokens_out, success, durationMs: duration_ms };
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
    // The POST won. Removing the entry is best-effort: if the write faults we
    // must NOT reclassify a committed submit as retryable — return submitted
    // regardless. A leftover entry is reconciled next session by server dedup.
    if (removeById(fresh, entry.estimate_id)) tryWrite(store, fresh, logger);
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
        // Persist the measured counts so a later session's retry resubmits THESE
        // counts once the key/plan is fixed — never a new session's transcript.
        fresh.entries[idx] = withPersistedCounts(fresh.entries[idx]!, counts);
        tryWrite(store, fresh, logger);
        return { submitted: false, retryable: false, terminal: false, gaveUp: false, error: err };
      }
      // A terminal 4xx (400/404/409/413/…) will never succeed. DROP it so it
      // can't head-of-line-block this project's queue — the manual/rollout paths
      // always act on the newest matching entry and have no TTL cleanup. If the
      // drop can't be persisted, still return the computed outcome (don't crash).
      fresh.entries.splice(idx, 1);
      tryWrite(store, fresh, logger);
      return { submitted: false, retryable: false, terminal: true, gaveUp: false, error: err };
    }
    const current = fresh.entries[idx]!;
    // Keep + bump attempts, AND persist the measured counts so a later session's
    // retry resubmits THESE counts (the ones for this estimate's own run) rather
    // than re-deriving them from whatever session happens to close the entry.
    const updated: PendingEntry = {
      ...withPersistedCounts(current, counts),
      attempts: current.attempts + 1,
    };
    if (updated.attempts >= MAX_ATTEMPTS) {
      fresh.entries.splice(idx, 1);
      tryWrite(store, fresh, logger);
      const detail = err instanceof BudgetaryError ? err.message : String(err);
      logger.warn(
        `Budgetary: giving up on actuals for ${entry.estimate_id} after ${MAX_ATTEMPTS} attempts (${detail}).`,
      );
      return { submitted: false, retryable, terminal: false, gaveUp: true, error: err };
    }
    fresh.entries[idx] = updated;
    tryWrite(store, fresh, logger);
    return { submitted: false, retryable, terminal: false, gaveUp: false, error: err };
  }
}

/**
 * Drop EVERY pending entry older than the TTL (not just the one this session is
 * about to close), re-reading first so a concurrent append isn't clobbered, and
 * warn ONCE with the count. Without this, an abandoned project's entry is
 * immortal — nothing else ever selects it, so it never expires. An unparseable
 * or FUTURE `created_at` has an unknown age and is deliberately KEPT (discarding
 * it could silently lose a session's own actual); it is left for a later run.
 */
function sweepExpired(
  store: PendingWriter,
  now: Date,
  logger: { warn(message: string): void },
): number {
  const fresh = store.read();
  const before = fresh.entries.length;
  const kept = fresh.entries.filter((e) => {
    const created = Date.parse(e.created_at);
    if (!Number.isFinite(created)) return true; // unknown age → keep
    const age = now.getTime() - created;
    if (age < 0) return true; // future timestamp (clock skew) → keep
    return age <= PENDING_TTL_MS;
  });
  const dropped = before - kept.length;
  if (dropped === 0) return 0;
  tryWrite(store, { version: 1, entries: kept }, logger);
  logger.warn(
    `Budgetary: dropped ${dropped} pending ${
      dropped === 1 ? "estimate" : "estimates"
    } past the 24h retry window.`,
  );
  return dropped;
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
  return projectIdFromCwd(cwd, args.home);
}

/** Small clock-skew tolerance for the started_at ↔ created_at comparison. */
const SESSION_START_SKEW_MS = 1000;

/**
 * Whether `entry` was created DURING the ending session, so this session's
 * transcript may be attributed to it. Uses `payload.started_at` when the host
 * provides it: an estimate created before the session began belongs to an
 * EARLIER session and must never receive this session's usage.
 *
 * Today's Claude Code SessionEnd payload does NOT carry `started_at` (nor does
 * Codex's Stop payload), so absent that signal this returns `true` and the
 * caller falls back to the project binding it already applied — the
 * persisted-counts RETRY path (part 1) carries the mis-pairing protection in
 * that case, and this session binding activates automatically for any host that
 * does send `started_at`. Bias is toward NOT mis-pairing: a genuinely stale
 * entry is left for the TTL sweep rather than paired with foreign usage.
 */
function belongsToThisSession(
  entry: PendingEntry,
  payload: SessionEndPayload | null,
): boolean {
  const startedAt =
    payload && typeof payload.started_at === "string"
      ? Date.parse(payload.started_at)
      : NaN;
  if (!Number.isFinite(startedAt)) return true; // no session boundary → fall back
  const created = Date.parse(entry.created_at);
  if (!Number.isFinite(created)) return false; // unparseable → not demonstrably ours
  return created >= startedAt - SESSION_START_SKEW_MS;
}

/**
 * Close out a pending estimate at session end. Two paths, both mis-pair-safe:
 *
 *  - RETRY: an entry that already carries measured counts from a prior FAILED
 *    submit (part 1) is resubmitted with THOSE counts — baked in, never
 *    re-derived from a transcript — so a cross-session retry can't mis-attribute.
 *  - FRESH: a never-submitted entry derives counts from THIS session's transcript
 *    and submits them, but only when the entry belongs to this session
 *    ({@link belongsToThisSession}) — so a later session's usage never pairs with
 *    an older estimate.
 *
 * The entry is selected by `project_id` (this session's cwd hash); the retry
 * uses its persisted counts, the fresh path is additionally session-bound.
 * Submits nothing unless real counts are available. Expired entries (all
 * projects) are swept first with a single warning naming the count. Routes the
 * submit through {@link submitActuals}.
 */
/**
 * A one-line stderr diagnostics sink for the session-end hook, gated by
 * {@link debugEnabled}. Off by default (the hook is silent on the happy path);
 * under `BUDGETARY_DEBUG=1` it narrates every decision so a lost actual becomes
 * traceable. Keeps the `Budgetary:` prefix and NEVER receives the API key —
 * callers pass the source/base-url/counts, never the value.
 */
function sessionEndDebug(
  env: NodeJS.ProcessEnv,
  stderr: { write(s: string): void },
): (message: string) => void {
  const on = debugEnabled(env);
  return (message: string): void => {
    if (on) stderr.write(`Budgetary: session-end: ${message}\n`);
  };
}

/** Map a {@link SubmitOutcome} to a breadcrumb outcome string. Never the key. */
function breadcrumbOutcome(outcome: SubmitOutcome): string {
  if (outcome.submitted) return "submitted";
  if (outcome.gaveUp) return "gave-up";
  if (outcome.terminal) return "rejected";
  // Kept pending: a retryable transport/5xx/429, or a user-fixable 401/403.
  const code =
    outcome.error instanceof BudgetaryError && outcome.error.httpStatus !== null
      ? String(outcome.error.httpStatus)
      : "network";
  return `failed:${code}`;
}

export async function runAutoActuals(args: AutoActualsArgs): Promise<number> {
  const logger = { warn: (m: string) => args.stderr.write(`${m}\n`) };
  const debug = sessionEndDebug(args.env, args.stderr);
  const store = new PendingStore({
    path: pendingFilePath(args.home),
    logger,
  });
  const clock = args.now ?? (() => new Date());
  const now = clock();

  // Leave a start-ONLY breadcrumb before any work: this `npx` hook has no
  // debugger and stdout is the JSON-RPC channel, so a persisted record is the
  // only durable instrument. If the host SIGKILLs this process past its 30 s
  // timeout, the absent durationMs/outcome is the interrupted-run marker. It is
  // overwritten with the completed record in the `finally` below.
  const startedAt = now.toISOString();
  writeBreadcrumb(args.home, { startedAt });
  debug(
    `started (reason=${
      args.payload && typeof args.payload.reason === "string"
        ? args.payload.reason
        : "(none)"
    })`,
  );

  // Every branch below sets `outcome` (and `estimateId` once one is selected) so
  // the `finally` records exactly why the run ended — the breadcrumb is honest
  // whether it submitted, no-op'd, or failed.
  let outcome = "no-entry";
  let estimateId: string | undefined;
  try {
    // Sweep ALL expired entries first — every project's, not just the one this
    // session would close — so an abandoned entry can't live forever, warning
    // once with the count. The selected entry below is therefore within the TTL
    // (or has an unknown/future age the sweep deliberately keeps).
    const swept = sweepExpired(store, now, logger);

    const file = store.read();
    debug(
      `pending store has ${file.entries.length} ${
        file.entries.length === 1 ? "entry" : "entries"
      }${swept > 0 ? ` (swept ${swept} past the 24h window)` : ""}`,
    );
    if (file.entries.length === 0) {
      // If the queue was drained by the TTL sweep, say so — "dropped-ttl" is more
      // honest than "no-entry" when this session's estimate aged out.
      outcome = swept > 0 ? "dropped-ttl" : "no-entry";
      debug(
        swept > 0
          ? "nothing to submit: the pending queue aged out of the 24h window"
          : "nothing to submit: the pending store is empty",
      );
      return 0;
    }

    // Bind to this session's own estimate; leave other sessions' entries alone.
    const projectId = sessionProjectId(args);
    const entry = newestForProject(file.entries, projectId);
    if (entry === null) {
      outcome = "no-entry";
      debug(
        `nothing to submit: no pending entry matches project_id=${
          projectId ?? "(unknown)"
        }`,
      );
      return 0;
    }
    estimateId = entry.estimate_id;
    debug(
      `matched estimate_id=${entry.estimate_id} project_id=${entry.project_id} attempts=${entry.attempts}`,
    );

    // RETRY vs FRESH. A prior FAILED submit persisted this estimate's OWN measured
    // counts onto the entry (part 1); resubmit THOSE — baked in, so this
    // cross-session retry can never mis-pair (it never re-reads a transcript).
    const retryCounts = persistedCounts(entry);
    let counts: ActualCounts;
    if (retryCounts !== null) {
      counts = retryCounts;
      debug(
        `retry path: resubmitting persisted counts (in=${retryCounts.tokensIn} out=${retryCounts.tokensOut})`,
      );
    } else {
      // FRESH path: this attaches THIS session's transcript to `entry`, so the
      // selected entry must be a live, this-session estimate — never a stale one.
      // Re-guard its age HERE and not only via the sweep: the sweep's write is
      // best-effort (a store-write fault leaves an expired entry on disk) and it
      // deliberately KEEPS unknown-age (unparseable created_at) entries, either of
      // which would otherwise reach this point and mis-pair this session's tokens
      // onto a foreign/stale estimate. (The retry path above is exempt: it submits
      // the entry's OWN persisted counts, which cannot mis-pair.)
      // "stale-skip" (NOT "dropped-ttl"): this branch KEEPS the entry — it only
      // declines to attribute THIS session's transcript to an entry that isn't
      // demonstrably a live, this-session estimate. Distinct from the sweep, which
      // actually drops. Reporting "dropped-ttl" here would lie in a breadcrumb
      // built for the operator: they'd read "expired" while the entry is still in
      // the queue. Split the two sub-cases so the message is honest.
      const created = Date.parse(entry.created_at);
      if (!Number.isFinite(created)) {
        outcome = "stale-skip";
        debug(
          "fresh path skipped: the matched entry has an unparseable created_at (kept, not submitted)",
        );
        return 0;
      }
      if (now.getTime() - created > PENDING_TTL_MS) {
        outcome = "stale-skip";
        debug(
          "fresh path skipped: the matched entry is stale (past the 24h window; not this session's to submit)",
        );
        return 0;
      }
      // Bind to the session too, when the host provides a boundary (started_at).
      if (!belongsToThisSession(entry, args.payload)) {
        outcome = "no-entry";
        debug(
          "fresh path aborted: the matched entry predates this session (started_at boundary)",
        );
        return 0;
      }
      if (args.payload === null) {
        outcome = "no-usage";
        debug("fresh path aborted: no session-end payload to read a transcript from");
        return 0;
      }
      const transcriptPath =
        typeof args.payload.transcript_path === "string"
          ? args.payload.transcript_path
          : null;
      if (transcriptPath === null) {
        outcome = "no-usage";
        debug("fresh path aborted: the payload carries no transcript_path");
        return 0;
      }

      // Honor the privacy opt-out: when trace detail is suppressed, the redacted
      // `target` is omitted (the trace keeps tool/tokens/kind and the leak-free
      // `ok`); the realized total is unaffected either way.
      const usage = (args.readUsage ?? readTranscriptUsage)(transcriptPath, {
        target: traceTargetEnabled(args.env),
      });
      if (usage === null) {
        outcome = "no-usage";
        // Name WHY (structural re-derivation, no content) — a silently-killed
        // session-end most often dies here on a transcript-format change.
        debug(
          `fresh path aborted: ${transcriptUnreadableReason(transcriptPath)}`,
        );
        return 0;
      }

      // Fail-closed: an over-cap or empty trace becomes `undefined`, so the total
      // still submits with no `trace` rather than failing or shipping invented steps.
      const trace = capTrace(usage.trace) ?? undefined;
      counts = {
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        success: isSuccessReason(args.payload.reason),
        durationMs: inferDurationMs(args.payload, entry, now),
        ...(trace ? { trace } : {}),
      };
      debug(
        `fresh path: measured in=${usage.tokensIn} out=${usage.tokensOut} trace_steps=${
          trace ? trace.length : 0
        }`,
      );
    }

    const resolved = resolveConfig(args.env, args.home);
    if (resolved === null) {
      outcome = "no-key";
      debug("no API key configured; leaving the entry for a later run");
      return 0; // leave the entry for a later session with a key
    }
    // Defense-in-depth for the hook path: the key reaches this unattended process
    // via a shell-interpolated hook command, so reject a value that isn't a
    // recognizable bg_live_/bg_test_ key rather than sending it. Leave the entry
    // for a later, correctly-configured run.
    if (!looksLikeBudgetaryKey(resolved.apiKey)) {
      outcome = "no-key";
      args.stderr.write(
        "Budgetary: the configured API key is not a recognizable bg_live_/bg_test_ key; " +
          "skipping the automatic actuals submission.\n",
      );
      return 0;
    }
    // Source + base URL only — the key VALUE is never logged.
    debug(`key source=${resolved.source} base_url=${resolved.baseUrl}`);

    const factory =
      args.clientFactory ??
      ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
    const client = factory({
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      maxRetries: UNATTENDED_MAX_RETRIES,
    });

    const submitOutcome = await submitActuals({
      store,
      client,
      entry,
      counts,
      logger,
    });
    outcome = breadcrumbOutcome(submitOutcome);
    const requestId =
      submitOutcome.error instanceof BudgetaryError
        ? submitOutcome.error.requestId
        : null;
    debug(`submit outcome=${outcome}${requestId ? ` request_id=${requestId}` : ""}`);

    // A terminal rejection drops the entry inside submitActuals WITHOUT a warning
    // (the give-up branch warns; the manual/rollout paths report their own drops).
    // This silent hook path must still leave a trace when a measured actual is lost
    // to a rejection — otherwise it vanishes from the pending queue with no signal
    // at all (INV-2: fail loud on failure).
    if (submitOutcome.terminal) {
      const detail =
        submitOutcome.error instanceof Error ? submitOutcome.error.message : "";
      args.stderr.write(
        `Budgetary: the server rejected actuals for ${entry.estimate_id}` +
          `${detail ? ` (${detail})` : ""} — it won't succeed on retry and was dropped.\n`,
      );
    }
    return 0;
  } catch (err) {
    // The CLI backstop (runOnSessionEndCli) still turns this into an exit-0 fail-
    // closed line; here we only record an honest breadcrumb before it propagates.
    outcome = "error";
    debug(
      `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  } finally {
    const durationMs = Math.max(0, clock().getTime() - now.getTime());
    writeBreadcrumb(args.home, { startedAt, durationMs, outcome, estimateId });
    debug(
      `finished outcome=${outcome}${
        estimateId ? ` estimate_id=${estimateId}` : ""
      } durationMs=${durationMs}`,
    );
  }
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
      ? newestForProject(file.entries, projectIdFromCwd(args.cwd, args.home))
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
  const client = factory({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    maxRetries: UNATTENDED_MAX_RETRIES,
  });

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

  const entry = newestForProject(
    file.entries,
    projectIdFromCwd(args.cwd, args.home),
  );
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
  const client = factory({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    maxRetries: UNATTENDED_MAX_RETRIES,
  });

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

/** A short, non-sensitive form of an estimate id for a one-line status row. */
function shortEstimateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/**
 * One honest line describing the last automatic (session-end hook) run, read
 * back from the breadcrumb {@link runAutoActuals} leaves. This is how the
 * otherwise-dark unattended path — where 100% of default calibration flows —
 * becomes legible: working / degrading / interrupted, at a glance. A start-only
 * record (no outcome/duration) means the hook was SIGKILLed past its timeout.
 */
function formatBreadcrumbHeader(crumb: SessionEndBreadcrumb, now: Date): string {
  const age = describeAge(crumb.startedAt, now);
  if (crumb.outcome === undefined || crumb.durationMs === undefined) {
    return `Last automatic session-end run: started ${age} but did not finish (interrupted).`;
  }
  const id = crumb.estimateId ? ` (${shortEstimateId(crumb.estimateId)})` : "";
  return `Last automatic submission: ${crumb.outcome}${id}, ${age}.`;
}

/** A short human age like "just now", "3h ago", "2d ago". */
export function describeAge(createdAt: string, now: Date): string {
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
  const now = (args.now ?? (() => new Date()))();

  // Surface the last automatic (session-end hook) run first — this is the only
  // place the otherwise-dark unattended path becomes visible, and it explains an
  // empty queue ("submitted 2h ago") as readily as a full one.
  const crumb = readBreadcrumb(args.home);
  if (crumb !== null) args.out(formatBreadcrumbHeader(crumb, now));

  if (entries.length === 0) {
    args.out("No pending Budgetary estimates — the loop is closed.");
    return 0;
  }

  const projectId =
    args.cwd !== undefined ? projectIdFromCwd(args.cwd, args.home) : null;
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
