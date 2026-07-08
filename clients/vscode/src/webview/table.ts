import type { LedgerEntry } from "@budgetary/sdk";

import { escapeHtml, formatTokens, truncateEstimateId } from "../format";

function resultCell(entry: LedgerEntry): string {
  // A glyph with an accessible label, so a screen reader announces the outcome
  // instead of an ambiguous symbol.
  if (entry.actual === null) return `<span aria-label="pending">○</span>`;
  return entry.actual.success
    ? `<span aria-label="succeeded">✓</span>`
    : `<span aria-label="failed">✗</span>`;
}

function predictedCell(entry: LedgerEntry): string {
  if (!entry.predicted) return "—";
  return formatTokens(entry.predicted.p50);
}

function rangeCell(entry: LedgerEntry): string {
  if (!entry.predicted) return "—";
  const { p10, p90 } = entry.predicted;
  if (!Number.isFinite(p10) || !Number.isFinite(p90) || p10 <= 0 || p90 <= 0) {
    return "—";
  }
  // Order defensively so odd wire data never renders an inverted range (the
  // chart clamps the same way).
  return `${formatTokens(Math.min(p10, p90))}–${formatTokens(Math.max(p10, p90))}`;
}

function actualCell(entry: LedgerEntry): string {
  if (entry.actual === null) return "—";
  return formatTokens(entry.actual.total);
}

function row(entry: LedgerEntry): string {
  const id = escapeHtml(truncateEstimateId(entry.estimateId, 12));
  const scenario = escapeHtml(entry.scenario);
  return `<tr>
    <td class="b-cell-id">${id}</td>
    <td class="b-cell-num">${predictedCell(entry)}</td>
    <td class="b-cell-num">${rangeCell(entry)}</td>
    <td class="b-cell-num">${actualCell(entry)}</td>
    <td class="b-cell-scenario b-scenario-${escapeHtml(entry.scenario)}">${scenario}</td>
    <td class="b-cell-done">${resultCell(entry)}</td>
  </tr>`;
}

export function renderRecentTable(entries: readonly LedgerEntry[]): string {
  if (entries.length === 0) {
    return `<p class="b-empty">No estimates yet.</p>`;
  }

  // Newest first by createdAt; entries already returned in this order from
  // the API, but sort defensively in case of future changes. An unparseable
  // date maps to -Infinity (sorts last) so the comparator stays transitive —
  // returning 0 for any unparseable pairing broke the total order.
  const ts = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : -Infinity;
  };
  const sorted = [...entries].sort((a, b) => {
    const ta = ts(a.createdAt);
    const tb = ts(b.createdAt);
    return ta === tb ? 0 : tb - ta;
  });

  return `<table class="b-table">
  <caption class="b-caption">Recent estimates — predicted vs. actual, newest first.</caption>
  <thead>
    <tr>
      <th scope="col">Estimate</th>
      <th scope="col" class="b-cell-num">Predicted p50</th>
      <th scope="col" class="b-cell-num">Range (p10–p90)</th>
      <th scope="col" class="b-cell-num">Actual</th>
      <th scope="col">Scenario</th>
      <th scope="col">Result</th>
    </tr>
  </thead>
  <tbody>
    ${sorted.map(row).join("\n    ")}
  </tbody>
</table>`;
}
