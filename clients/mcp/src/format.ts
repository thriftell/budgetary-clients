import type { EstimateResponse } from "@budgetary/sdk";

function commas(n: number): string {
  return n.toLocaleString("en-US");
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

/** Decode the bare confidence decimal into a plain-language band. */
function confidenceLabel(confidence: number): string {
  const c = Number.isFinite(confidence)
    ? Math.min(1, Math.max(0, confidence))
    : 0;
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
 * honesty about coverage reaches the surface. A void result intentionally omits
 * any pending-storage line — the caller stores nothing for it.
 */
export function renderEstimate(estimate: EstimateResponse): string {
  if (estimate.void || estimate.distribution === null) {
    return [
      "Budgetary cannot confidently estimate this query (out of domain).",
      "This estimate wasn't billed. Proceed without a prediction — at your own judgment.",
    ].join("\n");
  }

  const { p10, p50, p90 } = estimate.distribution;
  const view = scenarioView(estimate.scenario);
  const lines: string[] = [];
  if (view.leadWithRange) {
    lines.push(
      `Estimated range: ${commas(p10)}–${commas(p90)} tokens (p10–p90), midpoint ~${commas(p50)}`,
    );
    lines.push(`⚠ ${view.caution}`);
  } else {
    lines.push(
      `Estimated cost: ~${commas(p50)} tokens (range ${commas(p10)}–${commas(p90)}, p10–p90)`,
    );
  }
  lines.push(`Scenario: ${view.meaning}`);
  lines.push(`Confidence: ${confidenceLabel(estimate.confidence)}`);
  lines.push(`Model: ${estimate.model}`);
  lines.push("");
  lines.push("Pending estimate stored. After the run, actuals are recorded");
  lines.push("automatically (Claude Code) or via `npx @budgetary/mcp report-actual`.");
  return lines.join("\n");
}

/** 403: a valid key that is not on an active plan. Distinct from 401. */
export function renderPermissionDenied(): string {
  return "Your Budgetary key isn't on an active plan. Start one at https://budgetary.tools";
}

/** 401: the key itself was rejected. */
export function renderAuthFailed(): string {
  return "Your API key was rejected. Update it in `~/.budgetary/config.json` or set `BUDGETARY_API_KEY`.";
}

/** 429: rate limited. Includes the retry hint when the server surfaced one. */
export function renderRateLimited(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)) {
    return `Budgetary rate limit reached. Try again in ${retryAfterSeconds} seconds.`;
  }
  return "Budgetary rate limit reached. Try again in a little while.";
}

/** Network failures and 5xx. Surfaces request_id when present, with a retry affordance. */
export function renderTransportError(
  message: string,
  requestId: string | null,
): string {
  const tail = requestId ? ` (request_id: ${requestId})` : "";
  return `Budgetary couldn't be reached: ${message}${tail}. Please try again.`;
}
