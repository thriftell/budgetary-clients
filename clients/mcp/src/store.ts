import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

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
}

export interface PendingStoreFile {
  version: 1;
  entries: PendingEntry[];
}

function emptyFile(): PendingStoreFile {
  return { version: 1, entries: [] };
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

  write(file: PendingStoreFile): void {
    const dir = dirname(this.path);
    // The store lives under ~/.budgetary, alongside config.json (the API key), so
    // the directory is created owner-only (0700). An already-loose directory is
    // tightened best-effort so it doesn't stay world-traversable.
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // best-effort: not fatal if we can't tighten an existing dir
      }
    }
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
  }

  /**
   * Append an entry. Returns `true` iff it was actually written, `false` when
   * the append was refused (missing id, or the existing bytes are unrecoverable)
   * or the write failed — so a caller can tell the user honestly rather than
   * claim "stored". Never throws.
   */
  append(entry: PendingEntry): boolean {
    if (typeof entry.estimate_id !== "string" || entry.estimate_id.length === 0) {
      this.logger.warn(
        "Budgetary: refusing to append a pending entry without an estimate_id.",
      );
      return false;
    }
    const { file, writable } = this.readResult();
    if (!writable) {
      // The existing bytes are unrecoverable; do not overwrite them with a store
      // that would silently drop whatever was there.
      this.logger.warn(
        `Budgetary: pending store at ${this.path} is unreadable; not appending (existing file left intact).`,
      );
      return false;
    }
    file.entries.push(entry);
    try {
      this.write(file);
      return true;
    } catch (err) {
      this.logger.warn(
        `Budgetary: could not write the pending store at ${this.path}; the estimate was not stored. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return false;
    }
  }
}
