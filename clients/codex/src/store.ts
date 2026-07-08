// Verbatim copy of clients/claude-code/src/store.ts. Both plugins write to
// the same ~/.budgetary/pending.json; their schemas must stay byte-identical.
import {
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
    if (!existsSync(this.path)) return { file: emptyFile(), writable: true };
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
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
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Unique temp name: the store at ~/.budgetary/pending.json is shared across
    // concurrent sessions and both plugins, so a fixed `${path}.tmp` could be
    // half-written by one writer and renamed by another. A per-writer name makes
    // the write-then-rename atomic per writer.
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(file, null, 2));
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

  append(entry: PendingEntry): void {
    if (typeof entry.estimate_id !== "string" || entry.estimate_id.length === 0) {
      this.logger.warn(
        "Budgetary: refusing to append a pending entry without an estimate_id.",
      );
      return;
    }
    const { file, writable } = this.readResult();
    if (!writable) {
      // The existing bytes are unrecoverable; do not overwrite them with a store
      // that would silently drop whatever was there.
      this.logger.warn(
        `Budgetary: pending store at ${this.path} is unreadable; not appending (existing file left intact).`,
      );
      return;
    }
    file.entries.push(entry);
    this.write(file);
  }
}
