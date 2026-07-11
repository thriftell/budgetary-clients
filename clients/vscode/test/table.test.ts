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

  it("shows When + Query columns and a humanized scenario label", () => {
    const html = renderRecentTable([
      { ...entry("est_q", "2026-05-27T10:14:00Z", 100, "sparse_evidence"), queryExcerpt: "refactor the payments module" },
    ]);
    expect(html).toContain("<th scope=\"col\">When</th>");
    expect(html).toContain("<th scope=\"col\">Query</th>");
    expect(html).toContain("refactor the payments module");
    // formatTimestamp renders the createdAt (dead code before this).
    expect(html).toContain("2026-05");
    // Scenario is humanized for display (raw stays only in the class hook).
    expect(html).toContain(">sparse evidence</td>");
    expect(html).toContain("b-scenario-sparse_evidence");
  });

  it("notes the window in the caption only when the server has older pages (hasMore)", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      entry(`e${i}`, "2026-05-27T10:14:00Z", 100),
    );
    // No note when there is no more history — even at exactly 50 rows (the old
    // hardcoded ROW_CAP wrongly claimed "more" on a full-but-final page).
    expect(renderRecentTable(many)).not.toContain("most recent");
    expect(renderRecentTable(many, { hasMore: false })).not.toContain("most recent");

    // With older pages, the note keys on the ACTUAL rendered count — not 50 — so
    // a load-more'd view of 120 rows says 120, not a stale 50.
    expect(renderRecentTable(many, { hasMore: true })).toContain(
      "Showing the 50 most recent",
    );
    const oneWithMore = renderRecentTable(
      [entry("e1", "2026-05-27T10:14:00Z", 100)],
      { hasMore: true },
    );
    expect(oneWithMore).toContain("Showing the 1 most recent");
    expect(oneWithMore).toContain("older history isn't loaded");
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

  it("shows 'no prediction' (not 'pending') for an out-of-domain void row", () => {
    // A void has no prediction and never gets an actual — "○ pending" would imply
    // a measurement is still coming. It isn't.
    const html = renderRecentTable([
      entry("est_void", "2026-05-27T10:14:00Z", null, "out_of_domain"),
    ]);
    expect(html).toContain('aria-label="no prediction"');
    expect(html).toContain("no prediction");
    expect(html).not.toContain('aria-label="pending"');
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
