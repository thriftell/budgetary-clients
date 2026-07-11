import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";

import { withFileLock } from "./lock.js";

export interface PendingEntry {
  estimate_id: string;
  query: string;
  project_id: string;
  created_at: string;
  attempts: number;
  // --- Additive (v1-compatible) measured counts, persisted ONLY after a FAILED
  //     submit so a later session's retry resubmits THESE counts rather than
  //     re-deriving them from a different session's transcript (which would
  //     mis-pair the actual). Absent on a fresh estimate. Their presence and
  //     validity is re-checked at read time (a partial/corrupt write is ignored,
  //     not trusted), so they need no bump to the file `version`.
  tokens_in?: number;
  tokens_out?: number;
  success?: boolean;
  duration_ms?: number;
  /** Whether the original (failed) submit carried a trace; the retry sends totals only. */
  has_trace?: boolean;
  // --- Additive (v1-compatible) FORECAST band captured at ESTIMATE time. The
  //     estimate response already carried it, so this is a LOCAL store field, not
  //     a wire change: it lets a later `pending`/`doctor`/submit surface print
  //     "forecast ~M (p10–p90)" and place the realized actual within/above/below
  //     it — closing the forecast→actual loop for a human who never opens the VS
  //     Code dashboard. Absent on a void estimate (no distribution) or an entry
  //     written before this field existed. Re-validated at read time by each
  //     reader (a partial/corrupt write is ignored, not trusted), so — exactly
  //     like the measured counts above — they need no bump to the file `version`.
  forecast_p10?: number;
  forecast_p50?: number;
  forecast_p90?: number;
}

export interface PendingStoreFile {
  version: 1;
  entries: PendingEntry[];
}

function emptyFile(): PendingStoreFile {
  return { version: 1, entries: [] };
}

/**
 * How long a pending estimate stays eligible for automatic actuals submission.
 * Canonical home for the TTL: it is a property of the pending store's
 * lifecycle, applied both here (swept on append so a hook-less host's queue
 * can't grow without bound) and by the session-end hook's sweep. `actuals.ts`
 * imports it rather than redefining it, so the two never drift.
 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on entries kept in the store. Hook-less hosts (Codex/Cursor/Copilot)
 * never run the session-end sweep, so without a cap their `pending.json` grows
 * unbounded (~12.5k entries/yr). When an append would exceed the cap the oldest
 * entries (front of the insertion-ordered list) are evicted. Generous enough
 * that a real backlog of un-actualized estimates is never silently lost to the
 * cap before the 24h TTL sweep reclaims it.
 */
export const MAX_ENTRIES = 1000;

/**
 * Max stored length of an entry's `query`. The query is LOCAL-only — never sent
 * to the server — and no reader shows more than ~120 chars (the manual
 * `report-actual` excerpt), so a multi-KB pasted task description is pure
 * dead-weight in a file shared and rewritten by every concurrent session.
 * Truncated at append; 160 leaves comfortable headroom over every display.
 */
export const MAX_QUERY_LEN = 160;

/**
 * Whether `entry` is past the auto-submit TTL relative to `nowMs`. An
 * unparseable or FUTURE `created_at` has an unknown age and is deliberately NOT
 * expired (kept): discarding it could silently lose a session's own actual, so
 * it is left for a later, better-informed run. Shared by the append-time sweep
 * here and the session-end sweep in `actuals.ts` so both apply one rule.
 */
export function isEntryExpired(entry: PendingEntry, nowMs: number): boolean {
  const created = Date.parse(entry.created_at);
  if (!Number.isFinite(created)) return false; // unknown age → keep
  const age = nowMs - created;
  if (age < 0) return false; // future timestamp (clock skew) → keep
  return age > PENDING_TTL_MS;
}

/** Outcome of {@link PendingStore.append}. */
export interface AppendResult {
  /**
   * Whether the entry was actually written — `false` when the append was
   * refused (missing id, or the existing bytes are unrecoverable) or the write
   * failed. A caller must not claim "stored" unless this is `true`.
   */
  stored: boolean;
  /**
   * The post-append store snapshot (a fresh array; safe to read/filter). Lets a
   * caller compute a nudge count WITHOUT a second full re-read of the file —
   * and reflects exactly what landed on disk (post-sweep, post-eviction,
   * post-truncation). Empty when the append was refused.
   */
  entries: PendingEntry[];
}

/** The freshly-read state handed to a {@link PendingStore.mutate} callback. */
export interface MutateContext {
  file: PendingStoreFile;
  /**
   * `false` when the on-disk bytes could not be safely interpreted — the write
   * is then skipped so a mutation can never clobber unrecoverable data.
   */
  writable: boolean;
}

/** What a {@link PendingStore.mutate} callback returns. */
export interface MutateReturn<T> {
  /** The caller's result, surfaced whether or not the write happened. */
  value: T;
  /** Whether `file` was changed and should be persisted. */
  changed: boolean;
}

/** The outcome of a {@link PendingStore.mutate} call. */
export interface MutateOutcome<T> {
  value: T;
  /** Whether the mutated file was actually written back to disk. */
  wrote: boolean;
}

export interface StoreLogger {
  warn(message: string): void;
}

export interface StoreOptions {
  path: string;
  logger?: StoreLogger;
}

function isPendingEntry(value: unknown): value is PendingEntry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.estimate_id === "string" &&
    typeof e.query === "string" &&
    typeof e.project_id === "string" &&
    typeof e.created_at === "string" &&
    typeof e.attempts === "number"
  );
}

/**
 * Outcome of reading the store from disk. `writable` is false when the bytes
 * could not be safely interpreted (IO error, invalid JSON, foreign top-level
 * shape) — in that case a write would DESTROY unrecoverable data, so the
 * append path refuses rather than clobbering it with an empty store.
 */
interface ReadResult {
  file: PendingStoreFile;
  writable: boolean;
}

export class PendingStore {
  private readonly path: string;
  private readonly logger: StoreLogger;

  constructor(opts: StoreOptions) {
    this.path = opts.path;
    this.logger = opts.logger ?? { warn: () => {} };
  }

  read(): PendingStoreFile {
    return this.readResult().file;
  }

  private readResult(): ReadResult {
    // Read directly and classify by errno — do NOT gate on `existsSync` first.
    // `existsSync` returns `false` for ANY error (a lost read permission on
    // ~/.budgetary, EIO, a directory in the way), which would send a genuinely
    // unreadable store down the "empty + writable" first-run path; the very next
    // append would then overwrite whatever bytes are there with a fresh
    // one-entry file, destroying the whole queue. Branching in the catch keeps
    // ENOENT (a real first run) writable while routing every other failure into
    // the fail-closed, append-refusing path that preserves the existing bytes.
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return { file: emptyFile(), writable: true };
      }
      this.logger.warn(
        `Budgetary: could not read pending store at ${this.path}; leaving it untouched. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return { file: emptyFile(), writable: false };
    }
    if (raw.trim().length === 0) return { file: emptyFile(), writable: true };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        `Budgetary: pending store at ${this.path} is not valid JSON; leaving it untouched.`,
      );
      return { file: emptyFile(), writable: false };
    }
    if (parsed === null || typeof parsed !== "object") {
      this.logger.warn(
        `Budgetary: pending store at ${this.path} has an unexpected shape; leaving it untouched.`,
      );
      return { file: emptyFile(), writable: false };
    }
    const f = parsed as Record<string, unknown>;
    if (f.version !== 1 || !Array.isArray(f.entries)) {
      this.logger.warn(
        `Budgetary: pending store at ${this.path} has an unexpected shape; leaving it untouched.`,
      );
      return { file: emptyFile(), writable: false };
    }

    // Per-entry validation: keep the valid entries and drop only the malformed
    // ones. A single bad entry must not discard the whole store (which would
    // silently lose every other session's pending actuals).
    const valid: PendingEntry[] = [];
    let dropped = 0;
    for (const entry of f.entries) {
      if (isPendingEntry(entry)) valid.push(entry);
      else dropped += 1;
    }
    if (dropped > 0) {
      this.logger.warn(
        `Budgetary: dropped ${dropped} malformed pending ${
          dropped === 1 ? "entry" : "entries"
        } from ${this.path}.`,
      );
    }
    return { file: { version: 1, entries: valid }, writable: true };
  }

  /**
   * Ensure the store's parent directory exists and is owner-only (0700). It
   * lives under ~/.budgetary alongside config.json (the API key), so it must not
   * be group- or world-traversable; an already-loose directory is tightened
   * best-effort. Extracted so both {@link write} and {@link mutate}'s lock
   * acquisition have a directory to live in.
   */
  private ensureDir(): string {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // best-effort: not fatal if we can't tighten an existing dir
      }
    }
    return dir;
  }

  /** Path to the advisory lock that serializes concurrent read-modify-writes. */
  private lockPath(): string {
    return `${this.path}.lock`;
  }

  write(file: PendingStoreFile): void {
    const dir = this.ensureDir();
    // Unique temp name: the store at ~/.budgetary/pending.json is shared across
    // concurrent sessions and both plugins, so a fixed `${path}.tmp` could be
    // half-written by one writer and renamed by another. A per-writer name makes
    // the write-then-rename atomic per writer.
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      // `wx` create-exclusive (the unique name can't pre-exist except via a
      // planted symlink, which `wx` refuses to follow); `0600` keeps the pending
      // queries owner-only. The rename carries the mode onto the real file.
      writeFileSync(tmp, JSON.stringify(file, null, 2), { flag: "wx", mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best-effort cleanup only
      }
      throw err;
    }
    // Opportunistically reap temp files a crashed/SIGKILLed writer left behind
    // (its rename never ran). Only files older than the lock's stale window are
    // touched, so an in-flight temp from a concurrent writer is never removed.
    this.cleanupStaleTemps(dir);
  }

  /**
   * Best-effort removal of stale `pending.json.<pid>.<hex>.tmp` orphans (a
   * writer that died between the create and the rename). Conservative: only
   * temps whose mtime is older than 10 s are unlinked, so a live writer's
   * short-lived temp is left alone. Never throws — cleanup must not fail a write.
   */
  private cleanupStaleTemps(dir: string): void {
    const prefix = `${basename(this.path)}.`;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - 10_000;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const full = `${dir}/${name}`;
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // raced with the owning writer's own cleanup, or vanished — ignore.
      }
    }
  }

  /**
   * Serialize a read-modify-write against the shared store under the fail-open
   * advisory lock, so N concurrent sessions can't each write back a stale
   * snapshot (last-writer-wins → a silently lost entry, i.e. a lost calibration
   * pair). `fn` receives the freshly-read file (mutate its `entries` in place)
   * plus a `writable` flag, and returns a caller `value` with whether it
   * `changed` anything. The write is skipped when nothing changed (no needless
   * whole-file rewrite → less contention) or the bytes are unrecoverable (never
   * clobber). Never throws: a write fault degrades to `wrote: false`.
   *
   * The lock is FAIL-OPEN — under contention it proceeds unlocked rather than
   * risk the 30 s hook budget — so this reduces, but does not fully eliminate,
   * the last-writer-wins window; the per-write temp+rename keeps every write
   * byte-atomic regardless.
   */
  mutate<T>(fn: (ctx: MutateContext) => MutateReturn<T>): MutateOutcome<T> {
    // Best-effort: give the lock a directory to live in before contending. This
    // must NOT escape — mutate/append are contractually non-throwing. A dir that
    // can't be created (read-only HOME → EROFS, chmod 000 → EACCES) just means
    // the lock fails open (writeFileSync on a missing dir → ENOENT), and the real
    // fs fault is surfaced through the caught `this.write` below (→ wrote:false),
    // exactly as the pre-lock code degraded a first-run mkdir fault.
    try {
      this.ensureDir();
    } catch {
      // swallow — the write path reports any genuine, persistent fault
    }
    return withFileLock(this.lockPath(), () => {
      const { file, writable } = this.readResult();
      const { value, changed } = fn({ file, writable });
      if (!changed || !writable) return { value, wrote: false };
      try {
        this.write(file);
        return { value, wrote: true };
      } catch (err) {
        this.logger.warn(
          `Budgetary: could not write the pending store at ${this.path}; the change was not persisted. (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        return { value, wrote: false };
      }
    });
  }

  /**
   * Append an entry, serialized under the advisory lock so a concurrent
   * session's append off the same snapshot isn't lost. Returns whether it was
   * written and the post-append snapshot (so the caller's nudge needn't re-read
   * the file). Refused (`stored: false`) on a missing id or when the existing
   * bytes are unrecoverable; never throws.
   *
   * Maintenance runs on every successful append so a hook-less host's queue
   * stays bounded and lean: expired entries are swept (the 24h TTL, using the
   * caller's clock so it stays consistent with `entry.created_at`), the oldest
   * are evicted past {@link MAX_ENTRIES}, and the stored `query` is truncated to
   * {@link MAX_QUERY_LEN}. The append-path sweep is silent — the session-end
   * hook and `pending` surface TTL drops; an estimate flow shouldn't narrate
   * another estimate's expiry.
   */
  append(entry: PendingEntry, opts: { now?: () => Date } = {}): AppendResult {
    if (typeof entry.estimate_id !== "string" || entry.estimate_id.length === 0) {
      this.logger.warn(
        "Budgetary: refusing to append a pending entry without an estimate_id.",
      );
      return { stored: false, entries: [] };
    }
    // Defensive: a throwing injected clock must not escape append's no-throw
    // contract. A NaN result degrades the sweep to "keep all" (see below).
    let nowMs: number;
    try {
      nowMs = (opts.now ?? (() => new Date()))().getTime();
    } catch {
      nowMs = Number.NaN;
    }
    // Truncate the LOCAL-only query up front; a copy so the caller's object is
    // untouched.
    const stored: PendingEntry =
      entry.query.length > MAX_QUERY_LEN
        ? { ...entry, query: entry.query.slice(0, MAX_QUERY_LEN) }
        : entry;

    const { value, wrote } = this.mutate<PendingEntry[] | null>(({ file, writable }) => {
      if (!writable) {
        // The existing bytes are unrecoverable; do not overwrite them with a
        // store that would silently drop whatever was there.
        this.logger.warn(
          `Budgetary: pending store at ${this.path} is unreadable; not appending (existing file left intact).`,
        );
        return { value: null, changed: false };
      }
      // Sweep expired entries (all projects) so a hook-less host's queue can't
      // grow without bound; silent (see the doc comment).
      let kept = Number.isFinite(nowMs)
        ? file.entries.filter((e) => !isEntryExpired(e, nowMs))
        : file.entries;
      kept.push(stored);
      // Hard cap: keep the newest MAX_ENTRIES (front = oldest inserted). Warn
      // once when eviction actually happens — a 1,000-deep backlog is a real,
      // if rare, signal, not routine.
      if (kept.length > MAX_ENTRIES) {
        const evicted = kept.length - MAX_ENTRIES;
        kept = kept.slice(kept.length - MAX_ENTRIES);
        this.logger.warn(
          `Budgetary: pending store exceeded ${MAX_ENTRIES} entries; evicted ${evicted} oldest.`,
        );
      }
      file.entries = kept;
      return { value: kept, changed: true };
    });

    // value === null → refused (unwritable, already warned); !wrote → the write
    // faulted (mutate already warned). Either way it wasn't stored.
    if (value === null || !wrote) return { stored: false, entries: [] };
    return { stored: true, entries: value };
  }
}
