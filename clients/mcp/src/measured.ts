import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { Assessment, Efficiency, Phases, PhaseSlice } from "@budgetary/sdk";

import { withFileLock } from "./lock.js";

/**
 * The local buffer holding the measured summary the server returns on a
 * `POST /v1/actuals` 202, until a later `estimate` call can show it.
 *
 * ── Why a separate file, and never `pending.json` ──────────────────────────
 * The pending store's loader reconstructs its file as `{ version: 1, entries }`
 * (see `store.ts`), so ANY unrecognised top-level key is dropped on load and
 * therefore on the next write-back — silently, with no error. A `measured` key
 * added there would simply vanish. This buffer therefore lives in its own file
 * under `~/.budgetary/`, exactly as the one-time-notice marker does, which also
 * keeps it away from the money-adjacent store: nothing here can corrupt, evict
 * or delay a pending calibration pair.
 *
 * ── What it holds, and what it must never hold ────────────────────────────
 * Only what the server sent for one run, plus the local bookkeeping needed to
 * pair and show it once. Every displayed value is a server field copied
 * verbatim — this module validates shapes and drops what is malformed, but it
 * never transforms a value, never derives one, and never supplies a default for
 * an absent one. A field the server did not send is silence downstream.
 */

/**
 * How long a captured summary stays showable. Generous relative to the pending
 * store's 24 h auto-submit window because this is the OTHER side of the lag: an
 * actual submitted at one session's end is shown at the next estimate, which may
 * be days later on a project someone touches weekly. Past this the record is
 * ignored on read and evicted on the next write — an old run's breakdown
 * surfacing weeks later would read as noise, not as a promise kept.
 */
export const MEASURED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hard cap on buffered records. This is a display queue, not a ledger: the
 * server keeps every run, `GET /v1/ledger` serves them, and the VS Code
 * dashboard renders them. Five is enough that a burst of submits between two
 * estimates is not lost, and small enough that the file stays a few KB.
 */
export const MAX_MEASURED_RECORDS = 5;

/**
 * The server's measured read of ONE run, paired with the run it belongs to.
 *
 * `phases` and `assessment` are stored exactly as the SDK handed them over
 * (camelCased keys, values untouched). `estimate_id` is the pairing key and the
 * misattribution defense: it is printed on every render, so a summary can always
 * be traced to the run it measures.
 */
export interface MeasuredSummary {
  /** The estimate this summary measures. Always the FULL id; rendered short. */
  estimate_id: string;
  /**
   * The project the pending entry belonged to (the local cwd hash), when the
   * closed entry carried one. Used to prefer showing a summary in the project it
   * came from; absent on the `report-actual --estimate-id` path, whose synthetic
   * entry has no project. Never sent anywhere — it is already local-only.
   */
  project_id?: string;
  /** The measured phase breakdown, or null/absent when the server had none. */
  phases?: Phases | null;
  /** The server's plain-language read of the run. Present by construction. */
  assessment: Assessment;
}

/** A buffered {@link MeasuredSummary} plus the local bookkeeping around it. */
export interface MeasuredRecord extends MeasuredSummary {
  /** When this client captured it (ISO). Drives the TTL, never displayed. */
  captured_at: string;
  /** Set once the summary has been rendered, so it is never shown twice. */
  shown?: boolean;
}

/** The on-disk shape. Own top-level key so it can never be confused with the pending store's. */
export interface MeasuredFile {
  version: 1;
  records: MeasuredRecord[];
}

/**
 * A record claimed for display, plus whether it is KNOWN to come from a
 * different project directory than the one being estimated in.
 *
 * `otherProject` is false whenever the answer is unknown (the record carries no
 * project, or the caller named none) — the qualifier it drives is a positive
 * statement about local state and may only be printed when it is true.
 */
export interface MeasuredClaim {
  record: MeasuredRecord;
  otherProject: boolean;
}

/**
 * The minimal capture surface {@link import("./actuals.js").submitActuals}
 * needs, typed structurally (like `PendingWriter`) so a caller may inject its
 * own. A submit with no writer captures nothing — that is how the direct-submit
 * tests stay off the real `~/.budgetary`, and it is why every production path
 * wires one explicitly.
 */
export interface MeasuredWriter {
  record(summary: MeasuredSummary): void;
}

export interface MeasuredStoreOptions {
  path: string;
  logger?: { warn(message: string): void };
  now?: () => Date;
}

function emptyFile(): MeasuredFile {
  return { version: 1, records: [] };
}

/** A finite number, or null. Rejects NaN/Infinity so no render can print one. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-empty string, or null. */
function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One phase slice: exact tokens + its `[0,1]` share, both finite, or null. */
function validSlice(value: unknown): PhaseSlice | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const tokens = finite(v.tokens);
  const share = finite(v.share);
  if (tokens === null || share === null) return null;
  return { tokens, share };
}

const PHASE_KEYS = [
  "exploration",
  "generation",
  "testing",
  "retries",
  "other",
] as const;

/**
 * The five-phase breakdown, or `null` when the payload is absent, null, or in
 * any way malformed. ALL-OR-NOTHING on purpose: a breakdown missing a phase is
 * not a smaller breakdown, it is an unrenderable one — the shares no longer
 * account for the total, and printing four of five would misstate composition.
 * Every value is copied verbatim; nothing here is recomputed or normalized.
 */
export function validPhases(value: unknown): Phases | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const totalTokens = finite(v.totalTokens);
  const schemeVersion = nonEmpty(v.schemeVersion);
  if (totalTokens === null || schemeVersion === null) return null;
  const slices: Partial<Record<(typeof PHASE_KEYS)[number], PhaseSlice>> = {};
  for (const key of PHASE_KEYS) {
    const slice = validSlice(v[key]);
    if (slice === null) return null;
    slices[key] = slice;
  }
  return {
    exploration: slices.exploration!,
    generation: slices.generation!,
    testing: slices.testing!,
    retries: slices.retries!,
    other: slices.other!,
    totalTokens,
    schemeVersion,
  };
}

/**
 * The efficiency composition, or `null` — which the server itself sends when no
 * trace was forwarded, and which renders as silence. A malformed block degrades
 * to the same silence rather than to a partial line.
 */
function validEfficiency(value: unknown): Efficiency | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const burnShare = finite(v.burnShare);
  const label = nonEmpty(v.label);
  if (burnShare === null || label === null) return null;
  return { burnShare, label };
}

/**
 * The server's assessment, or `null` when there is none to show.
 *
 * `verdict` is the one required field: it is the answer, and a record without it
 * has nothing to render. Every value is copied as received — an unrecognized
 * verdict or label is kept exactly as sent, never folded into a known one and
 * never given a client-invented substitute.
 *
 * ⚠ Only the four keys the 202 carries are kept. The ledger's peer-benchmarked
 * `conversion` / `resolution` blocks are computed on `GET /v1/ledger` alone, so
 * they are ABSENT here rather than null — and absence must never be readable as
 * a value.
 */
export function validAssessment(value: unknown): Assessment | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const verdict = nonEmpty(v.verdict);
  if (verdict === null) return null;
  return {
    verdict,
    // A missing note is the same as no note; anything non-string is dropped
    // rather than stringified (it is prose for a human, never parsed).
    note: nonEmpty(v.note),
    efficiency: validEfficiency(v.efficiency),
    schemeVersion: typeof v.schemeVersion === "string" ? v.schemeVersion : "",
  };
}

/**
 * Build the capturable summary from a `POST /v1/actuals` 202 body, or `null`
 * when there is nothing to capture.
 *
 * ★ FAIL CLOSED TO SILENCE, with no version check anywhere. A deployment that
 * predates the additive fields returns a body with no `assessment` at all; this
 * returns null, nothing is written, and nothing is ever rendered. The same
 * happens for a body whose `assessment` is null (the server computed none) or
 * malformed. There is deliberately no fallback: a summary this client did not
 * receive is one it must not show.
 */
export function summaryFromActualsResponse(
  response: unknown,
  entry: { estimate_id: string; project_id?: string },
): MeasuredSummary | null {
  if (response === null || typeof response !== "object") return null;
  const assessment = validAssessment(
    (response as Record<string, unknown>).assessment,
  );
  if (assessment === null) return null;
  const estimateId = nonEmpty(entry.estimate_id);
  if (estimateId === null) return null;
  const phases = validPhases((response as Record<string, unknown>).phases);
  const projectId = nonEmpty(entry.project_id);
  return {
    estimate_id: estimateId,
    ...(projectId !== null ? { project_id: projectId } : {}),
    // `null` and absent both mean "no breakdown"; store null so the record's
    // shape is stable, and render both as silence.
    phases,
    assessment,
  };
}

/** Whether `record` is past the display TTL. An unparseable stamp is kept (unknown age). */
function isExpired(record: MeasuredRecord, nowMs: number): boolean {
  const captured = Date.parse(record.captured_at);
  if (!Number.isFinite(captured)) return false;
  const age = nowMs - captured;
  if (age < 0) return false; // clock skew — keep
  return age > MEASURED_TTL_MS;
}

/**
 * Re-validate one on-disk record, exactly as the pending store re-validates its
 * entries: nothing read back from disk is trusted, so a hand-edited or partially
 * written file degrades to fewer records rather than to a bad render.
 */
function validRecord(value: unknown): MeasuredRecord | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const estimateId = nonEmpty(v.estimate_id);
  const capturedAt = nonEmpty(v.captured_at);
  if (estimateId === null || capturedAt === null) return null;
  const assessment = validAssessment(v.assessment);
  if (assessment === null) return null;
  const projectId = nonEmpty(v.project_id);
  return {
    estimate_id: estimateId,
    captured_at: capturedAt,
    ...(projectId !== null ? { project_id: projectId } : {}),
    phases: validPhases(v.phases),
    assessment,
    ...(v.shown === true ? { shown: true as const } : {}),
  };
}

/**
 * The measured-summary buffer: captured by whichever process submits an actual,
 * read by the next `estimate` call in this install.
 *
 * Every method is best-effort and NON-THROWING. This is a cosmetic surface
 * riding on paths that have already committed to an outcome — a submit that
 * reached the server, or an estimate the user is waiting on — and neither may
 * fail because a display buffer could not be written.
 */
export class MeasuredStore implements MeasuredWriter {
  private readonly path: string;
  private readonly logger: { warn(message: string): void };
  private readonly now: () => Date;

  constructor(opts: MeasuredStoreOptions) {
    this.path = opts.path;
    this.logger = opts.logger ?? { warn: () => {} };
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Every valid, unexpired record, oldest first. Read-only; does not write, so a
   * caller can inspect the buffer without burning anything.
   */
  read(): MeasuredRecord[] {
    return this.load().records.filter((r) => !isExpired(r, this.nowMs()));
  }

  /**
   * Buffer one captured summary. Called from the submit path, so it must never
   * throw and never block: a failed write means the summary is simply not shown
   * later, which is strictly better than turning a successful submit into an
   * error.
   *
   * Re-capturing an `estimate_id` already in the buffer REPLACES it in place and
   * KEEPS its `shown` flag and original `captured_at`. An idempotent replay
   * (`report-actual --estimate-id` against an already-recorded run) returns the
   * same summary again; without this it would queue a second copy and show the
   * same breakdown twice, and a refreshed timestamp would extend its TTL forever.
   */
  record(summary: MeasuredSummary): void {
    const stamped: MeasuredRecord = {
      ...summary,
      captured_at: this.now().toISOString(),
    };
    this.mutate((file) => {
      const nowMs = this.nowMs();
      let kept = file.records.filter((r) => !isExpired(r, nowMs));
      const idx = kept.findIndex((r) => r.estimate_id === stamped.estimate_id);
      if (idx === -1) {
        kept.push(stamped);
      } else {
        const previous = kept[idx]!;
        kept[idx] = {
          ...stamped,
          captured_at: previous.captured_at,
          ...(previous.shown === true ? { shown: true as const } : {}),
        };
      }
      // Newest-wins eviction: the front of the insertion-ordered list is oldest.
      if (kept.length > MAX_MEASURED_RECORDS) {
        kept = kept.slice(kept.length - MAX_MEASURED_RECORDS);
      }
      file.records = kept;
      return true;
    });
  }

  /**
   * Claim the next summary to display, marking it shown, or `null` when there is
   * nothing to show.
   *
   * ★ The claim IS the write. A record is returned only once the `shown` flag has
   * actually landed on disk, so:
   *   - nothing is ever shown twice, even if two hosts estimate at the same
   *     moment (the read-mark-write runs under the shared advisory lock);
   *   - nothing is marked on a run that displayed nothing — when no record is
   *     eligible this returns null and writes NOTHING at all;
   *   - a buffer that cannot be written shows nothing rather than showing the
   *     same summary on every future estimate. That is the same
   *     fail-toward-silence choice `claimOneTimeNotice` makes, for the same
   *     reason: the one thing worse than a delayed summary is a nag that cannot
   *     be dismissed.
   *
   * `projectId` scopes the choice: the newest unshown record from THIS project
   * wins, and only if there is none does the newest unshown record from anywhere
   * get claimed. Cross-project display is deliberate rather than accidental —
   * see the PR — and it is always stamped with the estimate id it measures.
   */
  claim(projectId?: string | null): MeasuredClaim | null {
    const nowMs = this.nowMs();
    let claimed: MeasuredRecord | null = null;
    const wrote = this.mutate((file) => {
      const live = file.records.filter((r) => !isExpired(r, nowMs));
      const pickable = live.filter((r) => r.shown !== true);
      if (pickable.length === 0) return false; // nothing to show → nothing written
      const own =
        typeof projectId === "string" && projectId.length > 0
          ? pickable.filter((r) => r.project_id === projectId)
          : [];
      const pool = own.length > 0 ? own : pickable;
      const target = pool[pool.length - 1]!;
      claimed = { ...target, shown: true };
      file.records = live.map((r) =>
        r.estimate_id === target.estimate_id ? claimed! : r,
      );
      return true;
    });
    if (!wrote || claimed === null) return null;
    const record: MeasuredRecord = claimed;
    return {
      record,
      // Only ever true when BOTH projects are known and they differ.
      otherProject:
        typeof projectId === "string" &&
        projectId.length > 0 &&
        typeof record.project_id === "string" &&
        record.project_id.length > 0 &&
        record.project_id !== projectId,
    };
  }

  private nowMs(): number {
    try {
      return this.now().getTime();
    } catch {
      // A throwing injected clock must not escape a non-throwing method; an
      // unusable clock degrades the TTL to "keep everything", never to a crash.
      return Number.NaN;
    }
  }

  /**
   * Read the buffer. A missing, empty, unparseable, or foreign-shaped file all
   * degrade to EMPTY — unlike the pending store, which refuses to write over
   * bytes it could not interpret. The asymmetry is deliberate: that store holds
   * calibration pairs that exist nowhere else, while everything here is a copy of
   * something the server already has and still serves on `GET /v1/ledger`. So a
   * corrupt display buffer is repaired by the next capture rather than freezing
   * the surface forever.
   */
  private load(): MeasuredFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        this.logger.warn(
          `Budgetary: could not read the measured-summary buffer at ${this.path}; starting a fresh one.`,
        );
      }
      return emptyFile();
    }
    if (raw.trim().length === 0) return emptyFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        `Budgetary: the measured-summary buffer at ${this.path} is not valid JSON; starting a fresh one.`,
      );
      return emptyFile();
    }
    if (parsed === null || typeof parsed !== "object") return emptyFile();
    const f = parsed as Record<string, unknown>;
    if (f.version !== 1 || !Array.isArray(f.records)) return emptyFile();
    const records: MeasuredRecord[] = [];
    for (const value of f.records) {
      const record = validRecord(value);
      if (record !== null) records.push(record);
    }
    return { version: 1, records };
  }

  /**
   * Serialized read-modify-write under the same fail-open advisory lock the
   * pending store uses, so the session-end hook and an interactive server
   * capturing at the same moment do not lose each other's record. Under
   * contention the lock fails open and the last rename wins — acceptable here:
   * the loser's summary is a display copy of a row the server still holds.
   *
   * Returns whether the change actually reached disk. Never throws.
   */
  private mutate(fn: (file: MeasuredFile) => boolean): boolean {
    try {
      return withFileLock(`${this.path}.lock`, () => {
        const file = this.load();
        if (!fn(file)) return false;
        return this.write(file);
      });
    } catch {
      return false;
    }
  }

  /** Atomic unique-temp + rename, matching the pending store and the breadcrumb. */
  private write(file: MeasuredFile): boolean {
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      // Create the directory when it is missing, and do NOT touch its mode when
      // it exists — the pending store already tightens `~/.budgetary` to 0700 on
      // every write. Re-chmod-ing here would additionally RESTORE write
      // permission on a directory the user deliberately locked down, turning a
      // "this cannot be written" state into a silent success.
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      // `wx` create-exclusive (refuses a planted symlink rather than following
      // it); `0600` to match everything else under ~/.budgetary.
      writeFileSync(tmp, JSON.stringify(file, null, 2), { flag: "wx", mode: 0o600 });
      renameSync(tmp, this.path);
      return true;
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best-effort cleanup only
      }
      this.logger.warn(
        `Budgetary: could not write the measured-summary buffer at ${this.path}. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return false;
    }
  }
}
