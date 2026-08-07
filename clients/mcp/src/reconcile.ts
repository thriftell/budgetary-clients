import { readdirSync, readFileSync, statSync } from "node:fs";

import { BudgetaryClient, type BudgetaryClientOptions } from "@budgetary/sdk";

import {
  MAX_TRANSCRIPT_BYTES,
  capTrace,
  readTranscriptUsage,
  type ReadUsageOptions,
  type TranscriptUsage,
} from "./transcript.js";
import { persistedCounts, submitActuals, type ActualCounts } from "./actuals.js";
import { pendingFilePath } from "./config.js";
import {
  entryBinding,
  findProvenTranscript,
  isTranscriptDir,
} from "./session.js";
import { PendingStore, type PendingEntry } from "./store.js";

/**
 * Retry cap for the reconcile POST. Zero, for the same reason every other
 * unattended path is zero (`actuals.ts`): a server outage must not turn into
 * background work that outlives the estimate that triggered it. A failed
 * reconcile leaves the entry pending and the next estimate tries again, inside
 * the same `MAX_ATTEMPTS` budget every other submit path shares.
 */
const RECONCILE_MAX_RETRIES = 0;

/** Why a reconcile did nothing. Diagnostic only — never surfaced to the user. */
export type ReconcileOutcome =
  | "submitted"
  | "no-binding"
  | "no-transcript"
  | "no-usage"
  | "transcript-changed"
  | "no-key"
  | "not-submitted";

export interface ReconcileArgs {
  entry: PendingEntry;
  apiKey: string;
  baseUrl: string;
  home?: string;
  now?: () => Date;
  env: NodeJS.ProcessEnv;
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
  readUsage?: (path: string, options?: ReadUsageOptions) => TranscriptUsage | null;
  logger?: { warn(message: string): void };
}

/** Whether `path` contains `needle`, without parsing. Fail-closed on any fs error. */
function fileContains(path: string, needle: string): boolean {
  try {
    // The same cap `readTranscriptUsage` applies, for the same reason: the path
    // is resolved from stored state, so it must be a regular file within bounds
    // before it is read whole. An over-cap transcript is one we would refuse to
    // parse anyway, so there is nothing to gain by scanning it.
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) return false;
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Last-write time, or `null` when the file cannot be stat-ed. */
function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Size + mtime, or `null` if the file cannot be stat-ed. */
function fingerprint(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Close out ONE finished session's estimate, measured from that session's own
 * transcript.
 *
 * Runs AFTER the estimate response has been handed to the host (see
 * `tools/estimate.ts`), so nothing here can delay or fail the estimate. Every
 * step fails closed: a missing binding, an unprovable transcript, an unreadable
 * or unparseable file, a file that changed while being read, or a missing key
 * all mean SUBMIT NOTHING and leave the entry pending for a later estimate.
 * Nothing is ever fabricated, estimated, or fetched from a different transcript.
 *
 * Never throws: the caller attaches a terminal `.catch()` as a backstop, but the
 * body is fully guarded so that backstop should never fire.
 */
export async function reconcileEntry(
  args: ReconcileArgs,
): Promise<ReconcileOutcome> {
  const logger = args.logger ?? { warn: () => {} };
  const now = (args.now ?? (() => new Date()))();

  const binding = entryBinding(args.entry);
  if (binding === null) return "no-binding";

  const store = new PendingStore({
    path: pendingFilePath(args.home),
    logger,
  });
  const factory =
    args.clientFactory ??
    ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  // A SEPARATE client from the estimate's: the estimate deliberately keeps the
  // SDK's full retry ladder because a user is waiting for it. Nobody is waiting
  // for this.
  const client = factory({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    maxRetries: RECONCILE_MAX_RETRIES,
  });

  // A prior submit for this entry already FAILED with its counts measured and
  // persisted. Those are this estimate's own genuinely-measured numbers, so
  // resubmit exactly them and never re-derive from a transcript — re-measuring
  // here could only replace a real measurement with a worse one.
  const persisted = persistedCounts(args.entry);
  if (persisted !== null) {
    return finish(await trySubmit(persisted));
  }

  // The directory came back off disk, so re-derive the one constraint that
  // makes it safe to read from: it must be one of Claude Code's own transcript
  // directories. A doctored entry can therefore aim this at nothing else.
  if (!isTranscriptDir(binding.transcriptDir, args.home)) return "no-transcript";

  const path = findProvenTranscript(
    binding,
    { listDir, contains: fileContains, mtimeMs },
    Date.parse(args.entry.created_at),
  );
  if (path === null) return "no-transcript";

  // Read-stability: a transcript that changes while we are reading it was being
  // appended to, which means the session is not finished after all and any total
  // we derived is short. Fingerprint before and after and require they match —
  // this is the backstop for the case the process-liveness gate cannot see (an
  // MCP server that died while its session kept running).
  const before = fingerprint(path);
  if (before === null) return "no-transcript";

  // ★ `target` is OFF for a reconciled run, unconditionally. The redacted
  // target descriptor is governed by BUDGETARY_TRACE_TARGET, which belongs to
  // the run being measured — and this process holds a DIFFERENT session's
  // environment. Reading it here would apply the reconciling session's setting
  // to someone else's run, so an opt-out set while the work happened could be
  // silently overridden. With no honest source for the run's own answer, this
  // fails toward the less-disclosing direction, exactly as `traceTargetEnabled`
  // itself does: the trace still carries tool, tokens and the leak-free `ok`,
  // and the realized totals are unaffected either way.
  const usage = (args.readUsage ?? readTranscriptUsage)(path, { target: false });

  if (fingerprint(path) !== before) return "transcript-changed";
  if (usage === null) return "no-usage";

  // Fail-closed exactly like the hook path: an over-cap or empty trace becomes
  // `undefined`, so the totals still submit with no trace rather than shipping
  // a trimmed one that would misstate composition.
  const trace = capTrace(usage.trace) ?? undefined;

  const counts: ActualCounts = {
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    // We submit ONLY for a session whose serving process is gone and whose
    // transcript is complete and stable — i.e. one that ran to termination,
    // which is the same condition the hook path encodes as success (it counts
    // `clear` / `logout` / `prompt_input_exit`, the normal endings). The hook's
    // conservative default of `false` is not available to us: it keys off a
    // termination reason only the host can report, and defaulting to it would
    // stamp `false` on EVERY reconciled run — a systematic label, not a
    // measurement. See the PR for the divergence this leaves.
    success: true,
    // Measured, not inferred from this process's clock. The hook can bound the
    // run with a real session-end moment; we cannot, so the transcript's own
    // last-write time is used as the end bound. Using `now` here would report
    // the age of the ENTRY (up to a full day) as the run's duration.
    durationMs: durationFromTranscript(path, args.entry, now),
    ...(trace ? { trace } : {}),
  };

  return finish(await trySubmit(counts));

  async function trySubmit(measured: ActualCounts): Promise<boolean> {
    try {
      const outcome = await submitActuals({
        store,
        client,
        entry: args.entry,
        counts: measured,
        logger,
      });
      return outcome.submitted;
    } catch {
      // submitActuals already absorbs every expected failure; this is the
      // backstop for an unexpected one. Leave the entry pending.
      return false;
    }
  }

  function finish(submitted: boolean): ReconcileOutcome {
    return submitted ? "submitted" : "not-submitted";
  }
}

/**
 * The run's wall-clock, bounded by the transcript's last write. Falls back to 0
 * — never to `now - created_at`, which in a reconcile measures how long the
 * entry sat in the queue (potentially a full day), not how long the run took.
 */
function durationFromTranscript(
  path: string,
  entry: PendingEntry,
  now: Date,
): number {
  const created = Date.parse(entry.created_at);
  if (!Number.isFinite(created)) return 0;
  let endMs: number;
  try {
    endMs = statSync(path).mtimeMs;
  } catch {
    return 0;
  }
  // A transcript written before its own estimate, or after "now", is not a
  // measurement we can defend. Report 0 rather than a negative or absurd span.
  if (!Number.isFinite(endMs) || endMs < created || endMs > now.getTime() + 1000) {
    return 0;
  }
  return Math.max(0, Math.round(endMs - created));
}
