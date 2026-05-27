// Verbatim copy of clients/claude-code/src/store.ts. Both plugins write to
// the same ~/.budgetary/pending.json; their schemas must stay byte-identical.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
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

function isStoreFile(value: unknown): value is PendingStoreFile {
  if (value === null || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return (
    f.version === 1 &&
    Array.isArray(f.entries) &&
    f.entries.every(isPendingEntry)
  );
}

export class PendingStore {
  private readonly path: string;
  private readonly logger: StoreLogger;

  constructor(opts: StoreOptions) {
    this.path = opts.path;
    this.logger = opts.logger ?? { warn: () => {} };
  }

  read(): PendingStoreFile {
    if (!existsSync(this.path)) return emptyFile();
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      this.logger.warn(
        `Budgetary: could not read pending store at ${this.path}; resetting. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return emptyFile();
    }
    if (raw.trim().length === 0) return emptyFile();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoreFile(parsed)) {
        this.logger.warn(
          `Budgetary: pending store at ${this.path} has unexpected shape; resetting.`,
        );
        return emptyFile();
      }
      return parsed;
    } catch {
      this.logger.warn(
        `Budgetary: pending store at ${this.path} is not valid JSON; resetting.`,
      );
      return emptyFile();
    }
  }

  write(file: PendingStoreFile): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    renameSync(tmp, this.path);
  }

  append(entry: PendingEntry): void {
    const file = this.read();
    file.entries.push(entry);
    this.write(file);
  }
}
