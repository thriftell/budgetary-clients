import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

import { isEntryExpired, type PendingEntry } from "./store.js";

/**
 * The session the MCP server process was SPAWNED in. Injected by Claude Code
 * into every stdio MCP server's environment at spawn.
 *
 * ⚠ It names the spawning session, NOT the session currently calling the tool.
 * A `/clear` starts a new conversation (a new id, a new transcript) WITHOUT
 * restarting the MCP server, so from the second conversation onward this value
 * is stale. That is why it is only ever a HINT here: the authoritative pairing
 * is {@link TOOL_USE_ID_META}, which the host supplies per call.
 */
export const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

/** The project root Claude Code was launched in; also injected at spawn. */
export const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";

/**
 * The host-supplied id of THIS tool call, carried on the JSON-RPC request as
 * `params._meta["claudecode/toolUseId"]`. It is written verbatim into the
 * calling session's transcript as the `tool_use` block's `id`, which makes it
 * the one datum that can PROVE a transcript belongs to the session that created
 * a given pending entry. Host-supplied, never model-supplied.
 */
export const TOOL_USE_ID_META = "claudecode/toolUseId";

/**
 * A session id is used as a FILENAME (`<dir>/<session_id>.jsonl`), so it is a
 * path-injection surface: `..`, `/`, and a NUL would each escape the transcript
 * directory. Rather than sanitize, require the exact shape Claude Code emits —
 * a v4-style UUID. Anything else is not a session id we know how to resolve, and
 * "unrecognized" must mean "skip", never "try anyway".
 */
const SESSION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A tool-use id (`toolu_…`). Conservative charset; never used as a path segment. */
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The binding captured at ESTIMATE time that lets a LATER estimate close this
 * run out. Every field is resolved from the host environment or the host's own
 * request metadata — none is model-supplied, and none is ever sent on the wire.
 *
 * It is stamped on the entry (rather than re-resolved in the reconciling
 * process) for exactly the reason `source` is: the reconcile runs in a later,
 * unrelated session, and reading its environment would bind this run to that
 * session's transcript — the mis-pairing `store.ts` warns about.
 */
export interface SessionBinding {
  /** The spawning session id. A HINT for locating the transcript — see the caveat above. */
  sessionId: string;
  /** The host's id for the estimate call itself. The PROOF of which transcript is ours. */
  toolUseId: string;
  /** Absolute path of the directory Claude Code writes this project's transcripts into. */
  transcriptDir: string;
  /**
   * The MCP server process that served the estimate. Its death is the only
   * sound "that session is over" signal available — see {@link processAlive}.
   */
  ownerPid: number;
}

/**
 * Claude Code's transcript-directory name for an absolute path: every byte that
 * is not `[A-Za-z0-9]` becomes `-`. Verified against 273 real project
 * directories on a live machine plus a purpose-built launch in a directory
 * containing `.`, `_` and a space — all 274 reproduce exactly.
 *
 * The mapping is LOSSY (`a_b`, `a.b` and `a/b` all collapse to `a-b`), so it can
 * only ever be used to NARROW the search to a directory — never to conclude that
 * a file found there is ours. That conclusion is {@link TOOL_USE_ID_META}'s job.
 */
export function claudeProjectSlug(dir: string): string {
  return resolvePath(dir).replace(/[^A-Za-z0-9]/g, "-");
}

/** Where Claude Code keeps per-project transcripts. `home` is injectable for tests. */
function projectsRoot(home?: string): string {
  return join(home ?? homedir(), ".claude", "projects");
}

/**
 * Whether `dir` is a direct child of the transcripts root.
 *
 * `transcript_dir` is read back from `pending.json`, which is an ordinary file
 * in the user's home — and this server runs inside a host that can be talked
 * into writing files. Re-deriving the constraint here means a doctored entry
 * cannot aim the reader at an arbitrary directory: only ever at Claude Code's
 * own transcripts, which is the only place this feature has any business
 * reading. The value is still not TRUSTED — it must also hold a transcript
 * carrying this run's tool-use id before anything is read for content.
 */
export function isTranscriptDir(dir: string, home?: string): boolean {
  const root = projectsRoot(home);
  const resolved = resolvePath(dir);
  return dirname(resolved) === resolvePath(root) && resolved !== resolvePath(root);
}

/**
 * The transcript directory for this session, or `null` when the host is not
 * Claude Code (or its layout has changed).
 *
 * Both `CLAUDE_PROJECT_DIR` and the server's own cwd are tried, because the
 * directory is keyed on the cwd Claude Code was launched in and the two are not
 * guaranteed to be the same path. Whichever resolves to a real directory wins;
 * if neither does, we have no transcript directory and the run is simply not
 * reconcilable. Existence is checked HERE, at estimate time, while the session
 * is demonstrably alive and writing — not later, on a guess.
 */
export function resolveTranscriptDir(
  env: NodeJS.ProcessEnv,
  cwd: string,
  home?: string,
): string | null {
  const root = projectsRoot(home);
  const candidates = [env[PROJECT_DIR_ENV], cwd];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const dir = join(root, claudeProjectSlug(candidate));
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Not this one (absent, or unreadable). Try the next; never throw.
    }
  }
  return null;
}

export interface ResolveBindingArgs {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** `params._meta["claudecode/toolUseId"]` from the tool call, when the host sent one. */
  toolUseId?: string;
  home?: string;
  /** The MCP server's own pid; injectable for tests. */
  pid?: number;
}

/**
 * Capture the session binding for the run being estimated, or `null` when any
 * part of it is missing or malformed.
 *
 * ALL-OR-NOTHING on purpose. A partial binding cannot be used safely: without
 * the tool-use id there is no proof of which transcript is ours, and without the
 * pid there is no way to tell a finished session from a live one. A run we
 * cannot bind completely is a run this feature does not serve — which is not an
 * error, just a row it leaves alone.
 */
export function resolveSessionBinding(
  args: ResolveBindingArgs,
): SessionBinding | null {
  const sessionId = args.env[SESSION_ID_ENV];
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  const toolUseId = args.toolUseId;
  if (typeof toolUseId !== "string" || !TOOL_USE_ID_PATTERN.test(toolUseId)) {
    return null;
  }
  const transcriptDir = resolveTranscriptDir(args.env, args.cwd, args.home);
  if (transcriptDir === null) return null;
  const pid = args.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { sessionId, toolUseId, transcriptDir, ownerPid: pid };
}

/**
 * Re-validate a binding read back off an entry. Every field is re-checked
 * exactly like the measured counts and the forecast band are, so a partial or
 * hand-edited write is ignored rather than trusted — which is why these fields
 * need no bump to the store file's `version`.
 */
export function entryBinding(entry: PendingEntry): SessionBinding | null {
  const { session_id, tool_use_id, transcript_dir, owner_pid } = entry;
  if (typeof session_id !== "string" || !SESSION_ID_PATTERN.test(session_id)) {
    return null;
  }
  if (typeof tool_use_id !== "string" || !TOOL_USE_ID_PATTERN.test(tool_use_id)) {
    return null;
  }
  if (typeof transcript_dir !== "string" || transcript_dir.length === 0) {
    return null;
  }
  if (typeof owner_pid !== "number" || !Number.isSafeInteger(owner_pid) || owner_pid <= 0) {
    return null;
  }
  return {
    sessionId: session_id,
    toolUseId: tool_use_id,
    transcriptDir: transcript_dir,
    ownerPid: owner_pid,
  };
}

/**
 * Whether the MCP server process that served an estimate is still running.
 *
 * This is the liveness gate, and it is the load-bearing safety property of the
 * whole feature. `readTranscriptUsage` cannot tell a finished transcript from
 * one still being appended to — a torn final line is skipped and the earlier
 * lines still yield a complete-looking total — so reading a LIVE session's
 * transcript would submit a plausible, badly-low actual under a real estimate
 * id. The writer's own process is the signal: a stdio MCP server lives exactly
 * as long as the host keeps the session's connection open, so once it is gone,
 * nothing is appending to that transcript any more.
 *
 * A file mtime cannot substitute. Measured over 60 real sessions on this
 * machine, 35% contained a gap of more than two hours between consecutive
 * records — an idle session is indistinguishable from a finished one by
 * timestamp alone at any threshold short enough to be useful inside the 24 h TTL.
 *
 * Errs toward "alive": `EPERM` (the pid exists but belongs to another user) and
 * any unexpected failure count as running. A recycled pid therefore makes us
 * SKIP a reconcilable entry — the harmless direction. The opposite mistake, a
 * live session reported dead, cannot happen: a running process is always found.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // ESRCH is the ONLY answer that means "gone". Anything else is inconclusive,
    // and inconclusive must read as alive so we never submit on a guess.
    return code !== "ESRCH";
  }
}

export interface SelectArgs {
  entries: readonly PendingEntry[];
  /** The entry just appended by this estimate — never a candidate for itself. */
  excludeEstimateId: string;
  /**
   * Only this project's entries are eligible. `pending.json` is machine-wide but
   * credentials are not: the reconciling session posts with ITS OWN key and base
   * URL, and per-project keys are a documented install path. Closing another
   * project's run would file it against the wrong account.
   */
  projectId: string;
  /** This process's own session id, when the host supplied one. */
  currentSessionId?: string;
  nowMs: number;
}

/**
 * Pick at most one entry this estimate may close out, doing only work that is
 * free: array filtering plus one `process.kill(pid, 0)` per candidate. No file
 * is opened, no transcript is parsed and nothing is posted here — this runs on
 * the interactive estimate path, where a user is waiting, and in the
 * overwhelmingly common case it finds nothing and costs nothing.
 *
 * The gates, in order of cost, each of which fails closed to "skip":
 *
 *  1. A COMPLETE binding. An entry written by any earlier client carries none
 *     and is left strictly alone — guessing a transcript for it is precisely the
 *     mis-pairing `store.ts:23-28` already warns about.
 *  2. NOT this session's own entry. The spec's discriminator, and still the
 *     cheapest first cut — though note it is neither sufficient (a concurrent
 *     session is also "not mine") nor, after a `/clear`, reliable on its own.
 *     Gate 3 is what actually makes this safe.
 *  3. The serving MCP server process is GONE. See {@link processAlive}.
 *  4. Not past the TTL. `append` has already swept expired rows, but an
 *     unparseable or future `created_at` is deliberately KEPT by that sweep, so
 *     the age is re-checked here rather than assumed.
 *  5. ★ It is the SOLE pending entry from its session. A transcript measures a
 *     WHOLE session, so it can honestly close exactly one estimate — the same
 *     thing the hook does when it picks one entry per session end. If a session
 *     produced several estimates, the session's total belongs to no single one
 *     of them, and handing it to each in turn would file the same tokens two or
 *     three times over. There is no way to split a session total per estimate,
 *     so this submits nothing for that session rather than something inflated.
 *
 * At most one entry is closed per estimate.
 */
export function selectReconcilable(args: SelectArgs): PendingEntry | null {
  // How many pending entries each session has, so rule 5 costs one pass rather
  // than a scan per candidate.
  const perSession = new Map<string, number>();
  for (const entry of args.entries) {
    const b = entryBinding(entry);
    if (b !== null) perSession.set(b.sessionId, (perSession.get(b.sessionId) ?? 0) + 1);
  }

  for (const entry of args.entries) {
    if (entry.estimate_id === args.excludeEstimateId) continue;
    if (entry.project_id !== args.projectId) continue;
    const binding = entryBinding(entry);
    if (binding === null) continue;
    if (
      args.currentSessionId !== undefined &&
      binding.sessionId === args.currentSessionId
    ) {
      continue;
    }
    if (isEntryExpired(entry, args.nowMs)) continue;
    if ((perSession.get(binding.sessionId) ?? 0) !== 1) continue;
    if (processAlive(binding.ownerPid)) continue;
    return entry;
  }
  return null;
}

/**
 * The transcript that PROVES it belongs to `binding`, or `null`.
 *
 * The stored session id gives a fast path (`<dir>/<session_id>.jsonl`), but it
 * is only ever a hint — after a `/clear` it names an earlier conversation
 * entirely. So the file is accepted only once it is shown to contain this
 * estimate's own `tool_use` id, and when the fast path fails the other
 * transcripts in the same project directory are searched for that same proof.
 *
 * Exactly one match is required. Zero means we cannot prove anything and submit
 * nothing; more than one cannot happen for a host-issued id, and if it somehow
 * did, "pick one" would be a guess. Both outcomes fail closed.
 *
 * The proof is a plain substring scan — the id is an opaque host-issued token,
 * so there is nothing to parse and no JSON to validate to answer "is this id in
 * this file". `readTranscriptUsage` does the real parsing afterwards.
 */
export function findProvenTranscript(
  binding: SessionBinding,
  deps: {
    listDir: (dir: string) => string[];
    contains: (path: string, needle: string) => boolean;
    /** Last-write time of a transcript, or null when it cannot be stat-ed. */
    mtimeMs: (path: string) => number | null;
  },
  /**
   * When the estimate was made. The transcript that records this call cannot
   * have stopped being written BEFORE the call happened, so any file last
   * written before then provably isn't ours. Skipping those on a `statSync`
   * keeps the fallback from reading every transcript in a long-lived project
   * whole — the scan is off the response path, but it still runs on the live
   * server's only thread.
   */
  createdMs: number,
): string | null {
  const fast = join(binding.transcriptDir, `${binding.sessionId}.jsonl`);
  if (existsSync(fast) && deps.contains(fast, binding.toolUseId)) return fast;

  // Tolerate modest clock skew between the estimate's timestamp and the host's
  // file times rather than discarding a genuine match over a few seconds.
  const floor = Number.isFinite(createdMs) ? createdMs - MTIME_SLACK_MS : -Infinity;

  let found: string | null = null;
  for (const name of deps.listDir(binding.transcriptDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(binding.transcriptDir, name);
    if (path === fast) continue; // already tried
    const mtime = deps.mtimeMs(path);
    if (mtime === null || mtime < floor) continue;
    if (!deps.contains(path, binding.toolUseId)) continue;
    if (found !== null) return null; // ambiguous → prove nothing, submit nothing
    found = path;
  }
  return found;
}

/** Clock-skew tolerance when comparing an entry's timestamp to a file's mtime. */
const MTIME_SLACK_MS = 5 * 60 * 1000;
