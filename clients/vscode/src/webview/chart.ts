import type { LedgerEntry } from "@budgetary/sdk";

import { escapeHtml } from "../format";

const VIEW_W = 600;
const VIEW_H = 400;
const PAD_LEFT = 64;
const PAD_RIGHT = 24;
const PAD_TOP = 24;
const PAD_BOTTOM = 48;

const SCENARIO_COLORS: Record<string, string> = {
  confident: "var(--vscode-charts-blue)",
  uncertain: "var(--vscode-charts-yellow)",
  sparse_evidence: "var(--vscode-charts-orange)",
};

const UNKNOWN_COLOR = "var(--vscode-foreground)";
const UNKNOWN_OPACITY = 0.6;
const REFERENCE_LINE_COLOR = "var(--vscode-charts-foreground)";
const AXIS_COLOR = "var(--vscode-foreground)";
const GRID_COLOR = "var(--vscode-panel-border)";

interface Point {
  predicted: number;
  actual: number;
  scenario: string;
}

function pickPoints(entries: readonly LedgerEntry[]): Point[] {
  const out: Point[] = [];
  for (const e of entries) {
    if (!e.actual) continue;
    const p = e.predicted?.p50;
    const a = e.actual.total;
    if (
      typeof p !== "number" ||
      typeof a !== "number" ||
      !Number.isFinite(p) ||
      !Number.isFinite(a) ||
      p <= 0 ||
      a <= 0
    ) {
      continue;
    }
    out.push({ predicted: p, actual: a, scenario: e.scenario });
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
    if (p.predicted < lo) lo = p.predicted;
    if (p.actual < lo) lo = p.actual;
    if (p.predicted > hi) hi = p.predicted;
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

function colorForScenario(scenario: string): {
  fill: string;
  opacity: number;
} {
  // `scenario` is an open set (any wire string). Look it up as an OWN property
  // only, so an inherited key ("constructor", "toString", "__proto__") can never
  // masquerade as a color and inject a function/object into the `fill` attribute.
  const fill = Object.hasOwn(SCENARIO_COLORS, scenario)
    ? SCENARIO_COLORS[scenario]
    : undefined;
  if (fill) return { fill, opacity: 0.9 };
  return { fill: UNKNOWN_COLOR, opacity: UNKNOWN_OPACITY };
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
      ? "No calibration data yet. Run /estimate in Claude Code to start collecting points."
      : "Only one completed estimate so far — at least 2 are needed to plot calibration.";
  return `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="Empty calibration chart">
  <text x="${VIEW_W / 2}" y="${VIEW_H / 2}" text-anchor="middle" dominant-baseline="middle" fill="${AXIS_COLOR}" opacity="0.7" font-size="14">${msg}</text>
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

  const circles = points.map((p) => {
    const { fill, opacity } = colorForScenario(p.scenario);
    const cx = xScale(p.predicted, domain).toFixed(2);
    const cy = yScale(p.actual, domain).toFixed(2);
    return `<circle cx="${cx}" cy="${cy}" r="4" fill="${fill}" opacity="${opacity}"><title>predicted ${formatTick(p.predicted)} → actual ${formatTick(p.actual)} (${escapeHtml(p.scenario)})</title></circle>`;
  });

  const xAxisLabel = `<text x="${(VIEW_W + PAD_LEFT - PAD_RIGHT) / 2}" y="${VIEW_H - 12}" text-anchor="middle" fill="${AXIS_COLOR}" opacity="0.9" font-size="12">predicted (tokens, log)</text>`;
  const yAxisLabel = `<text x="-${(VIEW_H + PAD_TOP - PAD_BOTTOM) / 2}" y="18" transform="rotate(-90)" text-anchor="middle" fill="${AXIS_COLOR}" opacity="0.9" font-size="12">actual (tokens, log)</text>`;

  return `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="Calibration scatter plot">
  ${gridLines.join("\n  ")}
  ${referenceLine}
  ${axes}
  ${circles.join("\n  ")}
  ${tickLabels.join("\n  ")}
  ${xAxisLabel}
  ${yAxisLabel}
</svg>`;
}
