import type { LedgerEntry } from "@budgetary/sdk";

import { escapeHtml } from "../format";
import { markerShapeSvg, styleForScenario } from "./scenario";

const VIEW_W = 600;
const VIEW_H = 400;
const PAD_LEFT = 64;
const PAD_RIGHT = 24;
const PAD_TOP = 24;
const PAD_BOTTOM = 48;
const MARKER_R = 4;

const REFERENCE_LINE_COLOR = "var(--vscode-charts-foreground)";
const AXIS_COLOR = "var(--vscode-foreground)";
const GRID_COLOR = "var(--vscode-panel-border)";

/** id of the visually-hidden chart summary that render.ts provides. */
export const CHART_SUMMARY_ID = "b-chart-summary";

interface Point {
  /** p10 / p50 / p90 of the predicted band (the estimate is a range, not a point). */
  p10: number;
  p50: number;
  p90: number;
  actual: number;
  scenario: string;
}

function isPositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function pickPoints(entries: readonly LedgerEntry[]): Point[] {
  const out: Point[] = [];
  for (const e of entries) {
    if (!e.actual) continue;
    const pred = e.predicted;
    const p50 = pred?.p50;
    const a = e.actual.total;
    if (!isPositive(p50) || !isPositive(a)) continue;
    // p10/p90 are optional-safe: a missing/invalid bound falls back to p50 (the
    // whisker collapses to the marker) rather than dropping the point. Clamp so
    // p10 ≤ p50 ≤ p90 always holds for rendering, even on odd wire data.
    const p10 = Math.min(isPositive(pred?.p10) ? pred!.p10 : p50, p50);
    const p90 = Math.max(isPositive(pred?.p90) ? pred!.p90 : p50, p50);
    out.push({ p10, p50, p90, actual: a, scenario: e.scenario });
  }
  return out;
}

interface Domain {
  min: number;
  max: number;
  ticks: number[];
}

function computeDomain(points: readonly Point[]): Domain {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    // Include the whisker extremes (p10/p90) so the band stays inside the plot.
    if (p.p10 < lo) lo = p.p10;
    if (p.actual < lo) lo = p.actual;
    if (p.p90 > hi) hi = p.p90;
    if (p.actual > hi) hi = p.actual;
  }
  // Snap to powers of 10. Pad by one decade on each side if the span is small.
  const minExp = Math.floor(Math.log10(lo));
  let maxExp = Math.ceil(Math.log10(hi));
  if (maxExp <= minExp) maxExp = minExp + 1;
  const ticks: number[] = [];
  for (let e = minExp; e <= maxExp; e++) ticks.push(10 ** e);
  return { min: 10 ** minExp, max: 10 ** maxExp, ticks };
}

function xScale(value: number, domain: Domain): number {
  const t =
    (Math.log10(value) - Math.log10(domain.min)) /
    (Math.log10(domain.max) - Math.log10(domain.min));
  return PAD_LEFT + t * (VIEW_W - PAD_LEFT - PAD_RIGHT);
}

function yScale(value: number, domain: Domain): number {
  const t =
    (Math.log10(value) - Math.log10(domain.min)) /
    (Math.log10(domain.max) - Math.log10(domain.min));
  return VIEW_H - PAD_BOTTOM - t * (VIEW_H - PAD_TOP - PAD_BOTTOM);
}

function formatTick(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${value / 1_000}k`;
  return `${value}`;
}

function emptyState(plottable: number): string {
  // <2 points can't anchor a calibration line. Distinguish "nothing yet" from
  // "one point, need one more" so the message isn't misleading with 1 datum.
  const msg =
    plottable === 0
      ? "No calibration data yet. Run an estimate and record its actuals to start collecting points."
      : "Only one completed estimate so far — at least 2 are needed to plot calibration.";
  // The message is the accessible name (aria-label), so a screen reader reads
  // the actual guidance — not just "Empty calibration chart".
  return `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="${escapeHtml(msg)}">
  <text x="${VIEW_W / 2}" y="${VIEW_H / 2}" text-anchor="middle" dominant-baseline="middle" fill="${AXIS_COLOR}" opacity="0.7" font-size="14">${escapeHtml(msg)}</text>
</svg>`;
}

export function renderCalibrationChart(entries: readonly LedgerEntry[]): string {
  const points = pickPoints(entries);
  if (points.length < 2) return emptyState(points.length);

  const domain = computeDomain(points);

  const gridLines: string[] = [];
  const tickLabels: string[] = [];

  for (const t of domain.ticks) {
    const x = xScale(t, domain);
    const y = yScale(t, domain);
    gridLines.push(
      `<line x1="${x}" y1="${PAD_TOP}" x2="${x}" y2="${VIEW_H - PAD_BOTTOM}" stroke="${GRID_COLOR}" stroke-width="0.5" opacity="0.5"/>`,
    );
    gridLines.push(
      `<line x1="${PAD_LEFT}" y1="${y}" x2="${VIEW_W - PAD_RIGHT}" y2="${y}" stroke="${GRID_COLOR}" stroke-width="0.5" opacity="0.5"/>`,
    );
    tickLabels.push(
      `<text x="${x}" y="${VIEW_H - PAD_BOTTOM + 16}" text-anchor="middle" fill="${AXIS_COLOR}" opacity="0.8" font-size="11">${formatTick(t)}</text>`,
    );
    tickLabels.push(
      `<text x="${PAD_LEFT - 8}" y="${y + 4}" text-anchor="end" fill="${AXIS_COLOR}" opacity="0.8" font-size="11">${formatTick(t)}</text>`,
    );
  }

  // y=x reference line: connect (domain.min, domain.min) to (domain.max, domain.max).
  const refX1 = xScale(domain.min, domain);
  const refY1 = yScale(domain.min, domain);
  const refX2 = xScale(domain.max, domain);
  const refY2 = yScale(domain.max, domain);
  const referenceLine = `<line x1="${refX1}" y1="${refY1}" x2="${refX2}" y2="${refY2}" stroke="${REFERENCE_LINE_COLOR}" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`;

  // Axes (drawn after grid so they sit on top).
  const axes = `
  <line x1="${PAD_LEFT}" y1="${VIEW_H - PAD_BOTTOM}" x2="${VIEW_W - PAD_RIGHT}" y2="${VIEW_H - PAD_BOTTOM}" stroke="${AXIS_COLOR}" stroke-width="1"/>
  <line x1="${PAD_LEFT}" y1="${PAD_TOP}" x2="${PAD_LEFT}" y2="${VIEW_H - PAD_BOTTOM}" stroke="${AXIS_COLOR}" stroke-width="1"/>`;

  // p10–p90 whisker: a horizontal band on the predicted axis, so the marker is
  // read as the midpoint of a range, not a single predicted value. Drawn before
  // the markers so the circle sits on top.
  const whiskers = points.map((p) => {
    if (p.p10 >= p.p90) return ""; // degenerate band → no whisker
    const { color } = styleForScenario(p.scenario);
    const x1 = xScale(p.p10, domain).toFixed(2);
    const x2 = xScale(p.p90, domain).toFixed(2);
    const cy = yScale(p.actual, domain).toFixed(2);
    return `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity="0.35"/>`;
  });

  // Markers carry a SHAPE per scenario (not color alone), each translated to its
  // (predicted p50, actual) position so the same tooltip works for every shape.
  const markers = points.map((p) => {
    const style = styleForScenario(p.scenario);
    const cx = xScale(p.p50, domain).toFixed(2);
    const cy = yScale(p.actual, domain).toFixed(2);
    const title = `predicted ${formatTick(p.p50)} (p10–p90 ${formatTick(p.p10)}–${formatTick(p.p90)}) → actual ${formatTick(p.actual)} (${escapeHtml(p.scenario)})`;
    return `<g transform="translate(${cx} ${cy})">${markerShapeSvg(style.shape, MARKER_R, style.color, 0.9)}<title>${title}</title></g>`;
  });

  const xAxisLabel = `<text x="${(VIEW_W + PAD_LEFT - PAD_RIGHT) / 2}" y="${VIEW_H - 12}" text-anchor="middle" fill="${AXIS_COLOR}" opacity="0.9" font-size="12">predicted (tokens, log)</text>`;
  const yAxisLabel = `<text x="-${(VIEW_H + PAD_TOP - PAD_BOTTOM) / 2}" y="18" transform="rotate(-90)" text-anchor="middle" fill="${AXIS_COLOR}" opacity="0.9" font-size="12">actual (tokens, log)</text>`;

  const ariaLabel = `Calibration scatter plot of ${points.length} completed ${
    points.length === 1 ? "estimate" : "estimates"
  }, predicted vs. actual token spend on log scales.`;
  return `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="${escapeHtml(ariaLabel)}" aria-describedby="${CHART_SUMMARY_ID}">
  ${gridLines.join("\n  ")}
  ${referenceLine}
  ${axes}
  ${whiskers.join("\n  ")}
  ${markers.join("\n  ")}
  ${tickLabels.join("\n  ")}
  ${xAxisLabel}
  ${yAxisLabel}
</svg>`;
}
