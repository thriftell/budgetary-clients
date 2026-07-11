import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@budgetary/sdk";

import { MAX_PLOT_POINTS, renderCalibrationChart } from "../src/webview/chart";

function entry(
  estimateId: string,
  scenario: string,
  predictedP50: number,
  actualTotal: number | null,
): LedgerEntry {
  return {
    estimateId,
    createdAt: "2026-05-27T10:14:00Z",
    queryExcerpt: "q",
    model: "claude-opus-4-7",
    host: "claude-code",
    projectId: "p",
    scenario,
    predicted: {
      p10: predictedP50 / 4,
      p50: predictedP50,
      p90: predictedP50 * 4,
    },
    actual:
      actualTotal === null
        ? null
        : {
            tokensIn: Math.floor(actualTotal / 2),
            tokensOut: Math.ceil(actualTotal / 2),
            total: actualTotal,
            durationMs: 10000,
            success: true,
          },
  };
}

// Each data point is one translated marker group `<g transform="translate(…)">`.
function countMarkers(svg: string): number {
  const matches = svg.match(/<g transform="translate\(/g);
  return matches ? matches.length : 0;
}

describe("renderCalibrationChart", () => {
  it("renders one marker per plottable entry", () => {
    const entries = [
      entry("e1", "confident", 1_000, 1_200),
      entry("e2", "uncertain", 5_000, 12_000),
      entry("e3", "sparse_evidence", 20_000, 18_000),
      entry("e4", "confident", 80_000, 75_000),
    ];
    const svg = renderCalibrationChart(entries);
    expect(countMarkers(svg)).toBe(4);
  });

  it("drops entries with no actuals or with zero/negative tokens", () => {
    const entries = [
      entry("e1", "confident", 1_000, 1_200),
      entry("e2", "confident", 5_000, null),
      entry("e3", "confident", 0, 1_000),
      entry("e4", "confident", 1_000, -10),
      entry("e5", "confident", 1_000, 1_500),
    ];
    const svg = renderCalibrationChart(entries);
    expect(countMarkers(svg)).toBe(2);
  });

  it("includes a y=x reference line on log-log scale", () => {
    const entries = [
      entry("e1", "confident", 1_000, 1_200),
      entry("e2", "uncertain", 10_000, 12_000),
    ];
    const svg = renderCalibrationChart(entries);
    expect(svg).toMatch(/stroke-dasharray="4 4"/);
  });

  it("renders the empty-state message when fewer than 2 points are plottable", () => {
    const empty = renderCalibrationChart([]);
    expect(empty).toContain("No calibration data yet");
    // The message is the accessible name too (a screen reader reads the guidance).
    expect(empty).toContain('aria-label="No calibration data yet');
    expect(countMarkers(empty)).toBe(0);

    const onePoint = renderCalibrationChart([
      entry("e1", "confident", 1_000, 1_200),
    ]);
    // One point is not "no data" — the message says so honestly now.
    expect(onePoint).toContain("at least 2 are needed");
    expect(onePoint).not.toContain("No calibration data yet");
    expect(countMarkers(onePoint)).toBe(0);
  });

  it("scopes the empty-state copy when the fetched window has older pages", () => {
    // A windowed empty plot is NOT a global "no data" claim — older completed
    // pairs may exist beyond the fetched window (e.g. 50 orphans up top).
    const windowedEmpty = renderCalibrationChart([], { windowed: true });
    expect(windowedEmpty).not.toContain("No calibration data yet");
    expect(windowedEmpty).toContain("older history is not loaded");

    const windowedOne = renderCalibrationChart(
      [entry("e1", "confident", 1_000, 1_200)],
      { windowed: true },
    );
    expect(windowedOne).toContain("at least 2 are needed");
    expect(windowedOne).toContain("older history is not loaded");
  });

  it("caps plotted markers at MAX_PLOT_POINTS so the SVG stays bounded", () => {
    const many = Array.from({ length: MAX_PLOT_POINTS + 60 }, (_, i) =>
      entry(`e${i}`, "confident", 1_000 + i, 1_200 + i),
    );
    const svg = renderCalibrationChart(many);
    expect(countMarkers(svg)).toBe(MAX_PLOT_POINTS);
  });

  it("distinguishes scenarios by SHAPE, not color alone (non-color channel)", () => {
    const svg = renderCalibrationChart([
      entry("e1", "confident", 1_000, 1_200), // circle
      entry("e2", "uncertain", 5_000, 6_000), // triangle (polygon)
      entry("e3", "sparse_evidence", 20_000, 22_000), // square (rect)
    ]);
    // A marker circle, a polygon (triangle), and a rect (square) all appear.
    expect(svg).toMatch(/<g transform="translate\([^)]*\)"><circle\b/);
    expect(svg).toContain("<polygon");
    expect(svg).toMatch(/<g transform="translate\([^)]*\)"><rect\b/);
  });

  it("labels the data-bearing chart and points at a described-by summary", () => {
    const svg = renderCalibrationChart([
      entry("e1", "confident", 1_000, 1_200),
      entry("e2", "uncertain", 10_000, 12_000),
    ]);
    expect(svg).toContain('aria-label="Calibration scatter plot of 2');
    expect(svg).toContain('aria-describedby="b-chart-summary"');
  });

  it("draws a p10–p90 whisker per point and carries the range in the tooltip", () => {
    const svg = renderCalibrationChart([
      entry("e1", "confident", 1_000, 1_200),
      entry("e2", "uncertain", 10_000, 12_000),
    ]);
    // Each whisker is a horizontal band line (round caps, 0.35 opacity).
    const whiskers = svg.match(/<line[^>]*stroke-linecap="round"[^>]*opacity="0.35"/g) ?? [];
    expect(whiskers.length).toBe(2);
    // The band, not just the point, reaches the tooltip.
    expect(svg).toContain("p10–p90");
  });

  it("colors points per scenario", () => {
    const svg = renderCalibrationChart([
      entry("e1", "confident", 1_000, 1_200),
      entry("e2", "uncertain", 1_000, 1_200),
      entry("e3", "sparse_evidence", 1_000, 1_200),
      entry("e4", "future_label", 1_000, 1_200),
    ]);
    expect(svg).toContain("var(--vscode-charts-blue)");
    expect(svg).toContain("var(--vscode-charts-yellow)");
    expect(svg).toContain("var(--vscode-charts-orange)");
    expect(svg).toContain("var(--vscode-foreground)");
  });

  it("places points within the chart viewport", () => {
    const entries = [
      entry("e1", "confident", 1_000, 1_200),
      entry("e2", "uncertain", 50_000, 60_000),
    ];
    const svg = renderCalibrationChart(entries);
    const coords = Array.from(
      svg.matchAll(/<g transform="translate\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)\)"/g),
    );
    const xs = coords.map((m) => Number(m[1]));
    const ys = coords.map((m) => Number(m[2]));
    expect(xs.length).toBe(2);
    expect(ys.length).toBe(2);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(600);
    }
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(400);
    }
  });

  it("returns valid-looking SVG (root element + viewBox)", () => {
    const svg = renderCalibrationChart([]);
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain('viewBox="0 0 600 400"');
  });

  it("escapes a markup-shaped scenario in the point <title>", () => {
    const evil = '<script>alert(1)</script>';
    const svg = renderCalibrationChart([
      entry("e1", evil, 1_000, 1_200),
      entry("e2", "confident", 2_000, 2_400),
    ]);
    // Raw markup must not appear; the escaped form must.
    expect(svg).not.toContain("<script>alert(1)</script>");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("does not treat an inherited Object property name as a scenario color", () => {
    // "constructor"/"toString" are Object.prototype members; a plain lookup would
    // return a function and inject it into the fill attribute.
    const svg = renderCalibrationChart([
      entry("e1", "constructor", 1_000, 1_200),
      entry("e2", "toString", 2_000, 2_400),
    ]);
    expect(svg.toLowerCase()).not.toContain("function");
    expect(svg).not.toContain("[object");
    // Both fall through to the unknown color.
    expect(svg).toContain("var(--vscode-foreground)");
  });
});
