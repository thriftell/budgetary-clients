import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { budgetaryDir } from "./config.js";

/**
 * The single, best-effort breadcrumb the otherwise-DARK session-end hook leaves
 * on disk so the unattended path is legible after the fact. It records ONE run
 * (overwritten each session end), never the API key, and never any transcript
 * content — only when the run started, how long it took, what it decided, and
 * which estimate it acted on. This is the only durable evidence a `npx` hook run
 * (no debugger attaches) leaves behind: `pending`/`doctor` read it back.
 */
export function lastSessionEndPath(home?: string): string {
  return join(budgetaryDir(home), "last-session-end.json");
}

export interface SessionEndBreadcrumb {
  /** ISO timestamp the session-end hook began. Present on EVERY write. */
  startedAt: string;
  /**
   * Wall-clock the run took. ABSENT ⇒ the run did not complete — the host
   * SIGKILLed it past its 30 s timeout, or it crashed. Paired with an absent
   * {@link outcome}: a start-only record IS the interrupted-run marker.
   */
  durationMs?: number;
  /**
   * Terminal outcome. ABSENT ⇒ incomplete (see {@link durationMs}). One of:
   *   - `submitted`   — the POST succeeded and the entry was removed.
   *   - `no-entry`    — nothing matched this session (empty store / no project
   *                     match / predates the session boundary).
   *   - `no-usage`    — no payload, no transcript path, or the transcript yielded
   *                     no real counts.
   *   - `no-key`      — no key configured, or one that isn't a recognizable shape.
   *   - `dropped-ttl` — the TTL sweep drained the queue (entries actually dropped).
   *   - `stale-skip`  — the matched entry was KEPT but skipped as not-this-session
   *                     (unparseable or past-window `created_at`).
   *   - `rejected`    — a terminal 4xx; the entry was dropped.
   *   - `gave-up`     — {@link MAX_ATTEMPTS} reached; the entry was dropped.
   *   - `failed:<code>` — a retryable transport/plan failure; the entry was kept.
   *   - `error`       — an unexpected throw (still exited 0 via the CLI backstop).
   */
  outcome?: string;
  /** The estimate the run acted on, when one was selected. Never sensitive. */
  estimateId?: string;
}

/**
 * Persist the session-end breadcrumb, best-effort. NEVER throws: the hook's
 * contract is to fail closed, so a breadcrumb write fault (read-only HOME,
 * ENOSPC, a foreign-owned `~/.budgetary`) must never turn an otherwise-fine run
 * into a crash. Writes via a unique temp name + atomic rename, matching the
 * pending store — two sessions ending at once can't tear each other's record.
 */
export function writeBreadcrumb(
  home: string | undefined,
  crumb: SessionEndBreadcrumb,
): void {
  const path = lastSessionEndPath(home);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const dir = budgetaryDir(home);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `wx` create-exclusive (a planted symlink is refused, not followed); `0600`
    // to match the owner-only convention of everything else under ~/.budgetary.
    writeFileSync(tmp, JSON.stringify(crumb), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Observability must never break the hook. Clean up a stray temp if we can.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup only
    }
  }
}

/**
 * Read the last session-end breadcrumb, or `null` when absent / unreadable /
 * malformed. Re-validates every field so a partial or garbage file degrades to
 * "no breadcrumb" rather than a thrown error — a purely observational read must
 * never fault a status command.
 */
export function readBreadcrumb(home?: string): SessionEndBreadcrumb | null {
  let raw: string;
  try {
    raw = readFileSync(lastSessionEndPath(home), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.startedAt !== "string" || o.startedAt.length === 0) return null;
  const crumb: SessionEndBreadcrumb = { startedAt: o.startedAt };
  if (typeof o.durationMs === "number" && Number.isFinite(o.durationMs)) {
    crumb.durationMs = o.durationMs;
  }
  if (typeof o.outcome === "string" && o.outcome.length > 0) {
    crumb.outcome = o.outcome;
  }
  if (typeof o.estimateId === "string" && o.estimateId.length > 0) {
    crumb.estimateId = o.estimateId;
  }
  return crumb;
}
