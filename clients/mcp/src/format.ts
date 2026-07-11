import type { EstimateResponse } from "@budgetary/sdk";

function commas(n: number): string {
  return n.toLocaleString("en-US");
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
}

/**
 * The trailing "what happens next" lines, host-aware and honest about storage.
 * When the pending entry could NOT be stored, say so — never print "stored".
 * Automatic actuals on Claude Code require the plugin's session-end hook (a bare
 * `claude mcp add` wires only the estimate tool), so we don't over-promise.
 */
function storedFooter(host: string | undefined, stored: boolean): string[] {
  if (!stored) {
    return [
      "⚠ Couldn't save this as a pending estimate — the local store under ~/.budgetary",
      "  is unwritable, so it will NOT be recorded automatically. Fix ~/.budgetary,",
      "  then re-estimate, or submit actuals manually with `npx @budgetary/mcp report-actual`.",
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
  const meaning =
    lowConfidence && !view.leadWithRange
      ? "confident scenario, but low confidence — treat the range as the answer."
      : view.meaning;
  lines.push(`Scenario: ${meaning}`);
  lines.push(`Confidence: ${confidenceLabel(estimate.confidence)}`);
  lines.push(`Model: ${estimate.model}`);
  // The short estimate id, so a user can correlate this render with its `pending`
  // row and its eventual actuals submission (all show the same short form).
  lines.push(`Estimate id: ${shortEstimateId(estimate.estimateId)}`);
  lines.push("");
  lines.push(...storedFooter(options.host, options.stored ?? true));
  return lines.join("\n");
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

/** 429: rate limited. Includes the retry hint when the server surfaced one. */
export function renderRateLimited(
  retryAfterSeconds: number | null,
  requestId?: string | null,
): string {
  const tail = requestIdTail(requestId);
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)) {
    return `Budgetary rate limit reached. Try again in ${retryAfterSeconds} seconds.${tail}`;
  }
  return `Budgetary rate limit reached. Try again in a little while.${tail}`;
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
  const retryInfo =
    attempts !== undefined && attempts > 1
      ? ` after ${attempts} attempts${
          totalElapsedMs !== undefined && Number.isFinite(totalElapsedMs)
            ? // Clamp at 0: the SDK's monotonic clock never yields a negative, but
              // this is a public renderer — never print "over -2s".
              ` over ${Math.max(0, Math.round(totalElapsedMs / 1000))}s`
            : ""
        }`
      : "";
  return `Budgetary couldn't be reached: ${message}${tail}${retryInfo}. Please try again.`;
}
