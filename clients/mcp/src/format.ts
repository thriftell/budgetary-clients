import type { EstimateResponse } from "@budgetary/sdk";

function commas(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Render a successful or void estimate as the text shown to the user in the
 * MCP host. A void result intentionally omits any pending-storage line — the
 * caller stores nothing for it.
 */
export function renderEstimate(estimate: EstimateResponse): string {
  if (estimate.void || estimate.distribution === null) {
    return [
      "Budgetary cannot confidently estimate this query (out of domain).",
      "No charge — proceed at your own risk.",
    ].join("\n");
  }

  const { p10, p50, p90 } = estimate.distribution;
  const conf = estimate.confidence.toFixed(2);
  return [
    `Estimated cost: ${commas(p50)} tokens (p10–p90: ${commas(p10)}–${commas(p90)})`,
    `Scenario: ${estimate.scenario}   (confidence ${conf})`,
    `Model: ${estimate.model}`,
    "",
    "Pending estimate stored. After the run, actuals are recorded",
    "automatically (Claude Code) or via `npx @budgetary/mcp report-actual`.",
  ].join("\n");
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
