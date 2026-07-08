import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@budgetary/sdk";

import { renderRecentTable } from "../src/webview/table";

function entry(
  estimateId: string,
  createdAt: string,
  actualTotal: number | null,
  scenario = "confident",
): LedgerEntry {
  return {
    estimateId,
    createdAt,
    queryExcerpt: "q",
    model: "claude-opus-4-7",
    host: "claude-code",
    projectId: "p",
    scenario,
    predicted: { p10: 1, p50: 2, p90: 3 },
    actual:
      actualTotal === null
        ? null
        : {
            tokensIn: 1,
            tokensOut: 1,
            total: actualTotal,
            durationMs: 1,
            success: true,
          },
  };
}

describe("renderRecentTable", () => {
  it("renders pending (orphan) estimates as rows, not the empty state", () => {
    const html = renderRecentTable([
      entry("est_pending", "2026-05-27T10:14:00Z", null),
    ]);
    expect(html).not.toContain("No estimates yet");
    expect(html).toContain("est_pending");
    expect(html).toContain("<tr>");
    // A pending row shows a placeholder for the missing actual, not a number.
    expect(html).toContain("—");
  });

  it("shows the empty state only when there are truly no entries", () => {
    expect(renderRecentTable([])).toContain("No estimates yet");
  });

  it("shows a p10–p90 range column with the predicted band", () => {
    const html = renderRecentTable([
      entry("est_x", "2026-05-27T10:14:00Z", 100),
    ]);
    expect(html).toContain("Range (p10–p90)");
    // The fixture's predicted band is { p10: 1, p50: 2, p90: 3 }.
    expect(html).toContain("1–3");
  });

  it("has a caption, scope=col headers, and a Result column with accessible glyphs", () => {
    const done = renderRecentTable([
      entry("est_ok", "2026-05-27T10:14:00Z", 100),
    ]);
    expect(done).toContain("<caption");
    expect(done).toContain('scope="col"');
    expect(done).toContain("Result");
    expect(done).not.toContain("<th>Done</th>");
    // A succeeded run's glyph carries an accessible label.
    expect(done).toContain('aria-label="succeeded"');

    const pending = renderRecentTable([
      entry("est_pending", "2026-05-27T10:14:00Z", null),
    ]);
    expect(pending).toContain('aria-label="pending"');

    const failed = renderRecentTable([
      { ...entry("est_fail", "2026-05-27T10:14:00Z", 100), actual: { tokensIn: 1, tokensOut: 1, total: 100, durationMs: 1, success: false } },
    ]);
    expect(failed).toContain('aria-label="failed"');
  });

  it("escapes a markup-shaped scenario", () => {
    const html = renderRecentTable([
      entry("est_x", "2026-05-27T10:14:00Z", 100, "<b>x</b>"),
    ]);
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("sorts newest-first and tolerates unparseable dates (transitive, no throw)", () => {
    const html = renderRecentTable([
      entry("est_old", "2020-01-01T00:00:00Z", 100),
      entry("est_bad", "not-a-date", 100),
      entry("est_newest", "2030-01-01T00:00:00Z", 100),
    ]);
    const iNew = html.indexOf("est_newest");
    const iOld = html.indexOf("est_old");
    const iBad = html.indexOf("est_bad");
    // newest before old; the unparseable date maps to -Infinity → sorts last.
    expect(iNew).toBeGreaterThanOrEqual(0);
    expect(iNew).toBeLessThan(iOld);
    expect(iOld).toBeLessThan(iBad);
  });
});
