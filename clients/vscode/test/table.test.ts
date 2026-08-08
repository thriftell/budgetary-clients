import { describe, expect, it } from "vitest";
import type {
  Efficiency,
  LedgerAssessment,
  LedgerEntry,
  Phases,
} from "@budgetary/sdk";

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

/**
 * A server-shaped phase breakdown. Wire keys arrive camelCased by the SDK
 * transport (`total_tokens` → `totalTokens`); VALUES are never transformed.
 */
function phases(overrides: Partial<Phases> = {}): Phases {
  return {
    exploration: { tokens: 5_800, share: 0.12 },
    generation: { tokens: 22_500, share: 0.47 },
    testing: { tokens: 13_400, share: 0.28 },
    retries: { tokens: 4_300, share: 0.09 },
    other: { tokens: 1_900, share: 0.04 },
    totalTokens: 47_900,
    schemeVersion: "phases-2026-05",
    ...overrides,
  };
}

function assessment(
  verdict: string,
  efficiency: Efficiency | null = { burnShare: 0.13, label: "lean" },
): LedgerAssessment {
  return {
    verdict,
    note: null,
    efficiency,
    schemeVersion: "assess-2026-05",
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

  it("shows Measured + Normal? headers", () => {
    const html = renderRecentTable([entry("est_x", "2026-05-27T10:14:00Z", 100)]);
    expect(html).toContain('<th scope="col">Measured</th>');
    expect(html).toContain('<th scope="col">Normal?</th>');
  });

  it("every row has exactly as many cells as the header has columns", () => {
    // Guards the two new columns against a row/header drift that would silently
    // shift every value one column left.
    const html = renderRecentTable([
      {
        ...entry("est_full", "2026-05-27T10:14:00Z", 47_900),
        phases: phases(),
        assessment: assessment("normal"),
      },
      entry("est_bare", "2026-05-27T10:13:00Z", null),
    ]);
    const headers = html.match(/<th\b/g)?.length ?? 0;
    expect(headers).toBe(10);
    for (const tr of html.match(/<tr>[\s\S]*?<\/tr>/g)?.slice(1) ?? []) {
      expect(tr.match(/<td\b/g)?.length ?? 0).toBe(headers);
    }
  });

  it("renders the server's phase shares, its measured total, and its verdict", () => {
    const html = renderRecentTable([
      {
        ...entry("est_m", "2026-05-27T10:14:00Z", 47_900),
        phases: phases(),
        assessment: assessment("elevated", { burnShare: 0.13, label: "retry_heavy" }),
      },
    ]);
    // Every phase is named and shown — none dropped, merged or reordered by size.
    expect(html).toContain(
      "exploration 12% · generation 47% · testing 28% · retries 9% · other 4%",
    );
    // phases.totalTokens, not a client-side re-sum of the slices.
    expect(html).toContain("47,900 tokens measured");
    // The verdict is the RAW server value, not a client label.
    expect(html).toContain('<span class="b-verdict">elevated</span>');
    // The efficiency label likewise, raw.
    expect(html).toContain('<span class="b-efficiency">retry_heavy</span>');
    // The raw verdict is the class hook, exactly as the scenario column does it.
    expect(html).toContain("b-cell-verdict b-verdict-elevated");
  });

  it("renders an em-dash — never a computed guess — when phases/assessment are null", () => {
    const html = renderRecentTable([
      {
        ...entry("est_null", "2026-05-27T10:14:00Z", 47_900),
        phases: null,
        assessment: null,
      },
    ]);
    expect(html).toContain('<td class="b-cell-measured">—</td>');
    expect(html).toContain('<td class="b-cell-verdict">—</td>');
    // Nothing was invented in their place.
    expect(html).not.toContain("b-phase-list");
    expect(html).not.toContain("b-verdict");
    expect(html).not.toContain("tokens measured");
  });

  it("renders an em-dash when the fields are ABSENT (an older deployment)", () => {
    // `undefined` (field never sent) must read exactly like `null` (sent, nothing
    // to give): silence. The fixture omits both keys entirely.
    const html = renderRecentTable([entry("est_absent", "2026-05-27T10:14:00Z", 100)]);
    expect(html).toContain('<td class="b-cell-measured">—</td>');
    expect(html).toContain('<td class="b-cell-verdict">—</td>');
  });

  it("renders each block independently — a breakdown with no verdict, and the reverse", () => {
    const measuredOnly = renderRecentTable([
      {
        ...entry("est_p", "2026-05-27T10:14:00Z", 47_900),
        phases: phases(),
        assessment: null,
      },
    ]);
    expect(measuredOnly).toContain("47,900 tokens measured");
    expect(measuredOnly).toContain('<td class="b-cell-verdict">—</td>');

    const verdictOnly = renderRecentTable([
      {
        ...entry("est_a", "2026-05-27T10:14:00Z", 47_900),
        phases: null,
        assessment: assessment("normal"),
      },
    ]);
    expect(verdictOnly).toContain('<td class="b-cell-measured">—</td>');
    expect(verdictOnly).toContain('<span class="b-verdict">normal</span>');
  });

  it("gives insufficient_data the same treatment as any other verdict", () => {
    // The honest answer to "was that normal for a task like this?" — not an
    // error, not a partial result, and never hidden. The measured breakdown
    // beside it is exact and needs no comparison data at all.
    const html = renderRecentTable([
      {
        ...entry("est_insuf", "2026-05-27T10:14:00Z", 47_900),
        phases: phases(),
        assessment: assessment("insufficient_data", null),
      },
    ]);
    expect(html).toContain('<span class="b-verdict">insufficient_data</span>');
    expect(html).toContain("b-cell-verdict b-verdict-insufficient_data");
    // Styled by exactly the same markup as a `normal` row — no error class, no
    // warning glyph, no apology.
    const normal = renderRecentTable([
      {
        ...entry("est_insuf", "2026-05-27T10:14:00Z", 47_900),
        phases: phases(),
        assessment: assessment("normal", null),
      },
    ]);
    expect(html.replace(/insufficient_data/g, "normal")).toBe(normal);
    // The measurement still renders in full beside it.
    expect(html).toContain(
      "exploration 12% · generation 47% · testing 28% · retries 9% · other 4%",
    );
  });

  it("prints an unrecognized verdict as received (never folded into a known one)", () => {
    const html = renderRecentTable([
      {
        ...entry("est_new", "2026-05-27T10:14:00Z", 47_900),
        phases: phases(),
        assessment: assessment("some_future_label", null),
      },
    ]);
    expect(html).toContain('<span class="b-verdict">some_future_label</span>');
    expect(html).not.toContain("insufficient_data");
  });

  it("omits the efficiency line when the server returned no efficiency", () => {
    // `efficiency` is null when no trace was forwarded — composition cannot be
    // inferred without measured steps, so its absence is silence.
    const html = renderRecentTable([
      {
        ...entry("est_notrace", "2026-05-27T10:14:00Z", 47_900),
        phases: phases(),
        assessment: assessment("normal", null),
      },
    ]);
    expect(html).toContain('<span class="b-verdict">normal</span>');
    expect(html).not.toContain("b-efficiency");
  });

  it("prints insufficient_trace as received, like any other efficiency label", () => {
    const html = renderRecentTable([
      {
        ...entry("est_thin", "2026-05-27T10:14:00Z", 47_900),
        phases: phases(),
        assessment: assessment("normal", { burnShare: 0, label: "insufficient_trace" }),
      },
    ]);
    expect(html).toContain('<span class="b-efficiency">insufficient_trace</span>');
  });

  it("renders a positive-but-tiny share as '<1%', HTML-escaped", () => {
    const html = renderRecentTable([
      {
        ...entry("est_tiny", "2026-05-27T10:14:00Z", 47_900),
        phases: phases({ other: { tokens: 3, share: 0.00006 } }),
      },
    ]);
    expect(html).toContain("other &lt;1%");
    // The literal "<1%" must never reach the document unescaped.
    expect(html).not.toContain("<1%");
  });

  it("shows a per-phase em-dash rather than throwing on a malformed slice", () => {
    const html = renderRecentTable([
      {
        ...entry("est_bad", "2026-05-27T10:14:00Z", 47_900),
        phases: phases({ testing: { tokens: 0, share: NaN } }),
      },
    ]);
    expect(html).toContain("testing —");
    expect(html).toContain("generation 47%");
  });

  it("reads as silence, never a throw, on a malformed assessment", () => {
    // Typed as strings; a deployment that sends something else must degrade to
    // an em-dash, the same way a non-finite p10/p90 collapses the range cell.
    const html = renderRecentTable([
      {
        ...entry("est_junk", "2026-05-27T10:14:00Z", 100),
        assessment: { ...assessment(""), verdict: "" },
      },
      {
        ...entry("est_junk2", "2026-05-27T10:13:00Z", 100),
        assessment: assessment("normal", { burnShare: 0, label: "" }),
      },
    ]);
    expect(html).toContain('<td class="b-cell-verdict">—</td>');
    // The second row still shows its verdict — only the empty label is dropped.
    expect(html).toContain('<span class="b-verdict">normal</span>');
    expect(html).not.toContain("b-efficiency");
  });

  it("escapes a markup-shaped verdict and efficiency label", () => {
    const html = renderRecentTable([
      {
        ...entry("est_x", "2026-05-27T10:14:00Z", 100),
        assessment: assessment("<b>v</b>", { burnShare: 0, label: "<i>e</i>" }),
      },
    ]);
    expect(html).not.toContain("<b>v</b>");
    expect(html).not.toContain("<i>e</i>");
    expect(html).toContain("&lt;b&gt;v&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;e&lt;/i&gt;");
  });

  it("says in the caption where Measured and Normal? come from", () => {
    const html = renderRecentTable([entry("est_x", "2026-05-27T10:14:00Z", 100)]);
    expect(html).toContain(
      "Measured and Normal? are reported by the server; an em-dash means it reported none.",
    );
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
