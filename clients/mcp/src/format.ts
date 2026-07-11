import type { EstimateResponse } from "@budgetary/sdk";

import type { KeyPrefix } from "./config.js";

function commas(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * A one-line "actual N tokens vs forecast ~M (within/above/below p10–p90)"
 * comparison — the closed forecast→actual loop, in TOKENS ONLY (never a dollar
 * figure; the contract carries no price). `actualTotal` is tokens_in+tokens_out;
 * `band` is the estimate's combined-token p10/p50/p90. Returns `null` unless all
 * three band values are finite, so a missing/partial band degrades to "no
 * comparison" rather than a garbage line.
 */
export function forecastVsActual(
  actualTotal: number,
  band: { p10?: number; p50?: number; p90?: number },
): string | null {
  const { p10, p50, p90 } = band;
  if (
    typeof p10 !== "number" ||
    !Number.isFinite(p10) ||
    typeof p50 !== "number" ||
    !Number.isFinite(p50) ||
    typeof p90 !== "number" ||
    !Number.isFinite(p90)
  ) {
    return null;
  }
  const where =
    actualTotal > p90
      ? "above p10–p90"
      : actualTotal < p10
        ? "below p10–p90"
        : "within p10–p90";
  return `actual ${commas(actualTotal)} tokens vs forecast ~${commas(p50)} (${where})`;
}

/**
 * "forecast ~M tokens (p10–p90 A–B)" for a surface that has a forecast band but
 * no realized actual yet (a fresh pending row). Tokens only. `null` unless all
 * three band values are finite.
 */
export function forecastOnly(band: {
  p10?: number;
  p50?: number;
  p90?: number;
}): string | null {
  const { p10, p50, p90 } = band;
  if (
    typeof p10 !== "number" ||
    !Number.isFinite(p10) ||
    typeof p50 !== "number" ||
    !Number.isFinite(p50) ||
    typeof p90 !== "number" ||
    !Number.isFinite(p90)
  ) {
    return null;
  }
  return `forecast ~${commas(p50)} tokens (p10–p90 ${commas(p10)}–${commas(p90)})`;
}

/**
 * The shared "after N attempts over Ns" ordeal phrase (no leading space, empty
 * when a single/unknown attempt). Set on the error by the SDK's retry wrapper on
 * exhaustion; surfaced by both the transport-error and rate-limit renderers so a
 * ~4-minute backoff reads as the ordeal it was, not a first-attempt blip.
 */
function attemptsClause(attempts?: number, totalElapsedMs?: number): string {
  if (attempts === undefined || attempts <= 1) return "";
  const over =
    totalElapsedMs !== undefined && Number.isFinite(totalElapsedMs)
      ? // Clamp at 0: the SDK's monotonic clock never yields a negative, but this
        // is a public renderer — never print "over -2s".
        ` over ${Math.max(0, Math.round(totalElapsedMs / 1000))}s`
      : "";
  return `after ${attempts} attempts${over}`;
}

/**
 * A short, non-sensitive form of an `estimate_id` for a one-line surface — the
 * estimate footer, a submit confirmation, and each `pending` row all show the
 * SAME short form so a user can correlate a rendered estimate with its pending
 * entry and its eventual actuals submission. The full id lives server-side; this
 * is only a human-legible correlation handle, never a secret.
 */
export function shortEstimateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** Append a ` (request_id: X)` tail when the server surfaced one. */
function requestIdTail(requestId: string | null | undefined): string {
  return requestId ? ` (request_id: ${requestId})` : "";
}

interface ScenarioView {
  /** One-line, plain-language meaning of the scenario (contract §5). */
  meaning: string;
  /** Lead with the p10–p90 range + a caution, rather than the midpoint. */
  leadWithRange: boolean;
  /** Caution shown under a ⚠ when leading with the range. */
  caution: string;
}

/**
 * Humanize a scenario label into a plain-language meaning and a presentation
 * mode. Wide / sparse / unknown scenarios LEAD WITH THE RANGE and a caution so a
 * low-confidence estimate can never read like a confident precise number. Any
 * unrecognized label degrades to the "uncertain" presentation — the contract
 * (§5) says clients must treat unknown scenarios as `uncertain`.
 */
function scenarioView(scenario: string): ScenarioView {
  switch (scenario) {
    case "confident":
      return {
        meaning: "confident — well-supported, the range is reliable.",
        leadWithRange: false,
        caution: "",
      };
    case "sparse_evidence":
      return {
        meaning: "sparse evidence — near the edge of what Budgetary has seen.",
        leadWithRange: true,
        caution: "Thin evidence — the range may shift as more data arrives.",
      };
    case "uncertain":
      return {
        meaning: "uncertain — supported, but the range is wide.",
        leadWithRange: true,
        caution:
          "Wide range — treat the midpoint as a rough guess, not a number to rely on.",
      };
    default:
      // Unknown / future label → uncertain presentation (never a confident render).
      return {
        meaning: "uncertain — unrecognized scenario, treated as a wide range.",
        leadWithRange: true,
        caution:
          "Wide range — treat the midpoint as a rough guess, not a number to rely on.",
      };
  }
}

/** Confidence below which we always lead with the range, whatever the scenario. */
const LOW_CONFIDENCE = 0.5;

function clampConfidence(confidence: number): number {
  return Number.isFinite(confidence)
    ? Math.min(1, Math.max(0, confidence))
    : 0;
}

/** Decode the bare confidence decimal into a plain-language band. */
function confidenceLabel(confidence: number): string {
  const c = clampConfidence(confidence);
  let word: string;
  if (c >= 0.75) word = "high";
  else if (c >= 0.5) word = "moderate";
  else if (c >= 0.25) word = "low";
  else word = "very low";
  return `${c.toFixed(2)} (${word})`;
}

/**
 * Render a successful or void estimate as the text shown to the user in the
 * MCP host. The band is presented as a RANGE, never a bare point: a confident
 * estimate leads with an approximate midpoint plus the range; an uncertain /
 * sparse / unknown estimate leads with the range itself and a caution, so
 * honesty about coverage reaches the surface. The footer is host-aware and never
 * claims the estimate was stored when it wasn't. A void result intentionally
 * omits any pending-storage line — the caller stores nothing for it.
 */
export interface RenderEstimateOptions {
  /** The host tag (`claude-code`/`codex`/…) — selects the right actuals path. */
  host?: string;
  /** Whether the pending entry was actually stored (default true). */
  stored?: boolean;
  /**
   * The resolved key's public prefix (never the value). Surfaced as one footer
   * word so free-vs-paid is visible WHERE SPENDING HAPPENS — `bg_live_` bills a
   * paid key, `bg_test_` is free — not only in `doctor`.
   */
  keyPrefix?: KeyPrefix | null;
}

/**
 * The trailing "what happens next" lines, host-aware and honest about storage.
 * When the pending entry could NOT be stored, say so — never print "stored".
 * Automatic actuals on Claude Code require the plugin's session-end hook (a bare
 * `claude mcp add` wires only the estimate tool), so we don't over-promise.
 *
 * The un-stored branch takes the FULL `estimateId`: the estimate was ALREADY
 * billed, so it must NOT tell the user to "re-estimate" (a fresh UUID = a second
 * bill). Instead it leads with the free close — `report-actual --estimate-id
 * <id>`, which needs no pending row — and demotes re-estimating to a last resort.
 */
function storedFooter(
  host: string | undefined,
  stored: boolean,
  estimateId: string,
): string[] {
  if (!stored) {
    return [
      "⚠ Couldn't save this as a pending estimate — the local store under ~/.budgetary",
      "  is unwritable. This estimate was ALREADY billed, so do NOT re-estimate (that",
      "  bills again). Record its actuals directly against its id — no pending row needed:",
      `    npx @budgetary/mcp report-actual --estimate-id ${estimateId}`,
      "  Fix ~/.budgetary to restore automatic recording; re-estimating is a last resort.",
    ];
  }
  switch (host) {
    case "claude-code":
      return [
        "Pending estimate stored. With the Budgetary plugin installed, actuals are",
        "recorded automatically at session end — otherwise run `npx @budgetary/mcp report-actual`.",
      ];
    case "codex":
      return [
        "Pending estimate stored. After the run, record actuals with",
        "`npx @budgetary/mcp on-session-end --transcript <rollout>` (or `report-actual`).",
      ];
    default:
      return [
        "Pending estimate stored. After the run, record actuals with",
        "`npx @budgetary/mcp report-actual`.",
      ];
  }
}

export function renderEstimate(
  estimate: EstimateResponse,
  options: RenderEstimateOptions = {},
): string {
  if (estimate.void || estimate.distribution === null) {
    return [
      "Budgetary cannot confidently estimate this query (out of domain).",
      "This estimate wasn't billed. Proceed without a prediction — at your own judgment.",
    ].join("\n");
  }

  const { p10, p50, p90 } = estimate.distribution;
  const view = scenarioView(estimate.scenario);
  // Honesty coupling: the scenario and the confidence value are independent on
  // the wire, so a "confident" scenario can arrive with a low confidence. Never
  // let the two disagree on screen — a low confidence ALWAYS leads with the
  // range and drops the reassuring "reliable" framing, whatever the scenario.
  const lowConfidence = clampConfidence(estimate.confidence) < LOW_CONFIDENCE;
  const leadWithRange = view.leadWithRange || lowConfidence;
  const lines: string[] = [];
  if (leadWithRange) {
    lines.push(
      `Estimated range: ${commas(p10)}–${commas(p90)} tokens (p10–p90), midpoint ~${commas(p50)}`,
    );
    lines.push(
      `⚠ ${
        view.leadWithRange
          ? view.caution
          : "Low confidence — rely on the range, not the midpoint."
      }`,
    );
  } else {
    lines.push(
      `Estimated cost: ~${commas(p50)} tokens (range ${commas(p10)}–${commas(p90)}, p10–p90)`,
    );
  }
  // Name the tail explicitly so "p90" isn't left as jargon: p90 is the planning
  // worst case (~1 run in 10 lands above it), which the bare range doesn't spell out.
  lines.push(`Worst case (p90): ~${commas(p90)} tokens`);
  const meaning =
    lowConfidence && !view.leadWithRange
      ? "confident scenario, but low confidence — treat the range as the answer."
      : view.meaning;
  lines.push(`Scenario: ${meaning}`);
  lines.push(`Confidence: ${confidenceLabel(estimate.confidence)}`);
  lines.push(`Model: ${estimate.model}`);
  // "Valid until T" — the estimate goes stale after this (the model may have
  // moved); re-estimate rather than trusting it past then. Only shown when the
  // server sent a usable timestamp (older bodies may omit it).
  if (typeof estimate.expiresAt === "string" && estimate.expiresAt.length > 0) {
    lines.push(`Valid until: ${estimate.expiresAt}`);
  }
  // The short estimate id, so a user can correlate this render with its `pending`
  // row and its eventual actuals submission (all show the same short form).
  lines.push(`Estimate id: ${shortEstimateId(estimate.estimateId)}`);
  // Free-vs-paid, visible where the spend happens (not only in `doctor`).
  const keyLine = keyTierLine(options.keyPrefix);
  if (keyLine !== null) lines.push(keyLine);
  lines.push("");
  lines.push(...storedFooter(options.host, options.stored ?? true, estimate.estimateId));
  return lines.join("\n");
}

/** One-word key-tier footer line, or null for an unrecognized/absent prefix. */
function keyTierLine(prefix: KeyPrefix | null | undefined): string | null {
  if (prefix === "bg_live_") return "Key: bg_live_ (paid)";
  if (prefix === "bg_test_") return "Key: bg_test_ (free)";
  return null;
}

/** 403: a valid key that is not on an active plan. Distinct from 401. */
export function renderPermissionDenied(requestId?: string | null): string {
  return `Your Budgetary key isn't on an active plan. Start one at https://budgetary.tools${requestIdTail(requestId)}`;
}

/**
 * 401: the key itself was rejected. Names the source of the REJECTED key (env is
 * checked first, so a rejected key came from env when set), orders the fixes
 * env-first, is host-aware, and points at where to get a key.
 */
export function renderAuthFailed(
  host?: string,
  source?: "env" | "config",
  requestId?: string | null,
): string {
  const sourceLine =
    source === "env"
      ? "The API key in BUDGETARY_API_KEY was rejected."
      : source === "config"
        ? "The API key in ~/.budgetary/config.json was rejected."
        : "Your API key was rejected.";
  const fixLine =
    host === "claude-code"
      ? "Update it with `/plugin configure budgetary@budgetary`, or set BUDGETARY_API_KEY (checked first) / edit ~/.budgetary/config.json."
      : "Set a valid BUDGETARY_API_KEY (checked first), or update ~/.budgetary/config.json.";
  return [
    sourceLine,
    fixLine,
    `Get or check a key at https://budgetary.tools${requestIdTail(requestId)}`,
  ].join("\n");
}

/** Options enriching the 429 render from the SDK's `BudgetaryRateLimitError`. */
export interface RateLimitRenderOptions {
  requestId?: string | null;
  /** `X-RateLimit-Limit` — the tier's request ceiling for the window (§7). */
  limit?: number | null;
  /** `X-RateLimit-Remaining` — requests left in the window (§7). */
  remaining?: number | null;
  /** `X-RateLimit-Reset` — UNIX epoch SECONDS when the window resets (§7). */
  resetSeconds?: number | null;
  /** Retry-ladder ordeal annotation (set on the error on exhaustion). */
  attempts?: number;
  totalElapsedMs?: number;
  /** Injectable clock (ms) for the reset-relative calc; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * 429: rate limited. Beyond the retry hint, surfaces the tier's rate-limit
 * WINDOW (limit / remaining / reset — from the SDK's parsed `X-RateLimit-*`
 * headers) so "you've hit your tier limit of N, resets in ~Ns" reads honestly
 * instead of a bare "rate limited", plus the same attempts/elapsed ordeal
 * annotation the transport-error renderer carries. Every field is optional and
 * omitted when absent — never a fabricated number, never a dollar figure.
 */
export function renderRateLimited(
  retryAfterSeconds: number | null,
  opts: RateLimitRenderOptions = {},
): string {
  const bits: string[] = ["Budgetary rate limit reached."];
  bits.push(
    retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)
      ? `Try again in ${retryAfterSeconds} seconds.`
      : "Try again in a little while.",
  );
  if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
    const rem =
      typeof opts.remaining === "number" && Number.isFinite(opts.remaining)
        ? `, ${commas(opts.remaining)} left`
        : "";
    bits.push(`Tier limit: ${commas(opts.limit)} requests/window${rem}.`);
  }
  if (typeof opts.resetSeconds === "number" && Number.isFinite(opts.resetSeconds)) {
    const nowMs = (opts.now ?? (() => Date.now()))();
    const secs = Math.max(0, Math.round(opts.resetSeconds - nowMs / 1000));
    bits.push(`Window resets in ~${secs}s.`);
  }
  const clause = attemptsClause(opts.attempts, opts.totalElapsedMs);
  if (clause) bits.push(`(${clause}.)`);
  return `${bits.join(" ")}${requestIdTail(opts.requestId)}`;
}

/**
 * A 4xx the server deliberately rejected (bad/oversized request). This is NOT a
 * transport failure, so it must not advise a blind retry — it states the reason
 * and, where we know one, the concrete fix (413 → shorten the task).
 */
export function renderRequestRejected(
  message: string,
  requestId: string | null,
  httpStatus: number | null,
): string {
  const tail = requestId ? ` (request_id: ${requestId})` : "";
  // Only 413 has a safe, context-free fix. For other 4xx the server message
  // carries the detail — don't invent a cause (a 404 here can be a wrong
  // base_url, not a missing estimate).
  const fix =
    httpStatus === 413 ? " Shorten the task description and try again." : "";
  return `Budgetary rejected the request: ${message}${tail}.${fix}`;
}

/**
 * Network failures and 5xx. Surfaces request_id when present, with a retry
 * affordance. When the SDK exhausted its retry ladder, the additive `attempts` /
 * `totalElapsedMs` from the error are shown as "after N attempts over Ns" — so a
 * ~4-minute 429/5xx backoff reads as the ordeal it was, not a first-attempt blip.
 */
export function renderTransportError(
  message: string,
  requestId: string | null,
  attempts?: number,
  totalElapsedMs?: number,
): string {
  const tail = requestId ? ` (request_id: ${requestId})` : "";
  const clause = attemptsClause(attempts, totalElapsedMs);
  const retryInfo = clause ? ` ${clause}` : "";
  return `Budgetary couldn't be reached: ${message}${tail}${retryInfo}. Please try again.`;
}
