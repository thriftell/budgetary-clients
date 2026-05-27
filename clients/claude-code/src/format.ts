import type { EstimateResponse } from "@budgetary/sdk";

function commas(n: number): string {
  return n.toLocaleString("en-US");
}

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
    "Pending estimate stored. Run the task and Budgetary will record the actuals",
    "when the session ends.",
  ].join("\n");
}

export function renderSdkError(message: string, requestId: string | null): string {
  const tail = requestId ? `   (request_id: ${requestId})` : "";
  return `Budgetary error: ${message}${tail}`;
}
