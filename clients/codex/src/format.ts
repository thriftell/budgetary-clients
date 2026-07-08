// Verbatim copy of clients/claude-code/src/format.ts.
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
 * mode. Wide / sparse / unknown scenarios lead with the RANGE and a caution so a
 * low-confidence estimate can never read like a confident precise number.
 * Unknown labels degrade to the "uncertain" presentation (contract §5).
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
  lines.push("Pending estimate stored. Run the task and Budgetary will record the actuals");
  lines.push("when the session ends.");
  return lines.join("\n");
}

export function renderSdkError(message: string, requestId: string | null): string {
  const tail = requestId ? `   (request_id: ${requestId})` : "";
  return `Budgetary error: ${message}${tail}`;
}
