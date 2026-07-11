import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@budgetary/sdk";

import {
  renderConfigUnreadable,
  renderConfigureKey,
  renderDashboard,
  renderError,
  renderLoading,
} from "../src/webview/render";

const NONCE = "n0nce-deadbeef";

function entry(id: string): LedgerEntry {
  return {
    estimateId: id,
    createdAt: "2026-05-27T10:14:00Z",
    queryExcerpt: "q",
    model: "claude-opus-4-7",
    host: "claude-code",
    projectId: "p",
    scenario: "confident",
    predicted: { p10: 100, p50: 500, p90: 2000 },
    actual: {
      tokensIn: 200,
      tokensOut: 280,
      total: 480,
      durationMs: 9000,
      success: true,
    },
  };
}

/** An out-of-domain VOID: no prediction, and it never receives an actual. */
function voidEntry(id: string): LedgerEntry {
  return {
    ...entry(id),
    scenario: "out_of_domain",
    actual: null,
  };
}

describe("renderDashboard", () => {
  it("emits a CSP meta tag that carries the nonce", () => {
    const html = renderDashboard([entry("est_1"), entry("est_2")], NONCE);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy"`);
    expect(html).toContain(`script-src 'nonce-${NONCE}';`);
    expect(html).toContain(`default-src 'none'`);
  });

  it("the inline <script> nonce matches the CSP nonce", () => {
    const html = renderDashboard([entry("est_1"), entry("est_2")], NONCE);
    expect(html).toContain(`<script nonce="${NONCE}">`);
    // No script tags without a nonce attribute.
    const scriptOpens = html.match(/<script\b[^>]*>/g) ?? [];
    for (const tag of scriptOpens) {
      expect(tag).toContain(`nonce="${NONCE}"`);
    }
  });

  it("contains the chart and the table", () => {
    const html = renderDashboard([entry("est_1"), entry("est_2")], NONCE);
    expect(html).toContain("<svg");
    expect(html).toContain("<table");
  });

  it("contains no external URLs in the rendered HTML", () => {
    const html = renderDashboard([entry("est_1"), entry("est_2")], NONCE);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("wires the refresh button to postMessage({ type: 'refresh' })", () => {
    const html = renderDashboard([entry("est_1")], NONCE);
    expect(html).toContain('id="refresh"');
    expect(html).toContain('postMessage({ type: "refresh" })');
  });

  it("has section <h2> headings and a data-bearing chart summary", () => {
    const html = renderDashboard([entry("est_1"), entry("est_2")], NONCE);
    expect(html).toContain('<h2 id="b-chart-h">Calibration</h2>');
    expect(html).toContain('<h2 id="b-recent-h">Recent estimates</h2>');
    expect(html).toContain('id="b-chart-summary"');
  });

  it("legend lists the PLOTTABLE scenarios with shape marks, from one source", () => {
    const html = renderDashboard([entry("est_1")], NONCE);
    expect(html).toContain("confident");
    expect(html).toContain("sparse evidence");
    expect(html).toContain("b-legend-mark"); // each item carries a shape swatch
    // The legend is a semantic list, not a pile of spans.
    expect(html).toContain('<ul class="b-legend"');
    // out_of_domain is never plotted (pickPoints skips voids), so it must NOT
    // carry a dead legend swatch advertising a marker the chart never draws.
    expect(html).not.toContain("out of domain");
  });

  it("surfaces the out-of-coverage void rate when there are voids", () => {
    const html = renderDashboard(
      [entry("est_1"), voidEntry("est_void_a"), voidEntry("est_void_b")],
      NONCE,
    );
    expect(html).toContain("2 of the last 3 estimates were out-of-coverage voids");
  });

  it("uses singular copy for exactly one void", () => {
    const html = renderDashboard([entry("est_1"), voidEntry("est_void")], NONCE);
    expect(html).toContain("1 of the last 2 estimates was an out-of-coverage void");
  });

  it("omits the void-rate stat when there are no voids", () => {
    const html = renderDashboard([entry("est_1"), entry("est_2")], NONCE);
    expect(html).not.toContain("out-of-coverage void");
  });

  it("announces refresh via aria-live and preserves scroll/focus across reloads", () => {
    const html = renderDashboard([entry("est_1")], NONCE);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // The refresh script persists + restores state.
    expect(html).toContain("getState()");
    expect(html).toContain("setState(");
    expect(html).toContain("window.scrollTo");
    expect(html).toContain(".focus()");
    // Focus is consumed, not sticky — a later reload won't steal it back.
    expect(html).toContain("refreshFocused: false");
  });

  it("renders a cost summary strip: actual vs forecast in TOKENS, with the median ratio", () => {
    // Two paired entries: predicted p50 = 500 each; actuals total 480 each.
    const html = renderDashboard([entry("est_1"), entry("est_2")], NONCE);
    expect(html).toContain("b-cost-summary");
    expect(html).toContain("2 estimates loaded");
    // actual total 960, forecast total 1,000; median ratio 480/500 = 0.96×.
    expect(html).toContain("960 tokens actual vs ~1,000 forecast");
    expect(html).toContain("median 0.96× actual/forecast");
    // Tokens only — never a dollar figure.
    expect(html).not.toContain("$");
  });

  it("cost summary counts pending + voids and says 'none with actuals yet' when unpaired", () => {
    const html = renderDashboard(
      [
        { ...entry("est_paired") }, // has an actual
        { ...entry("est_pending"), actual: null }, // awaiting actuals
        voidEntry("est_void"), // out-of-domain, no prediction/actual
      ],
      NONCE,
    );
    expect(html).toContain("1 pending");
    expect(html).toContain("1 void");

    // All-unpaired page → honest "none with actuals yet", no median.
    const unpaired = renderDashboard(
      [{ ...entry("e1"), actual: null }, { ...entry("e2"), actual: null }],
      NONCE,
    );
    expect(unpaired).toContain("none with actuals yet");
    expect(unpaired).not.toContain("median");
    expect(unpaired).toContain("2 pending");
  });

  it("cost summary is windowed-honest when older pages exist (never implies the whole ledger)", () => {
    const html = renderDashboard([entry("e1"), entry("e2")], NONCE, {
      nextCursor: "cur_x",
    });
    const strip = html.slice(html.indexOf("b-cost-summary"));
    expect(strip).toContain("most recent; older history not loaded");
  });

  it("renders a 'Load older' control + window qualifier when nextCursor is non-null", () => {
    const html = renderDashboard([entry("e1"), entry("e2")], NONCE, {
      nextCursor: "cur_abc",
    });
    expect(html).toContain('id="load-older"');
    expect(html).toContain('postMessage({ type: "loadMore" })');
    // The Calibration heading is qualified so it never implies "the whole ledger".
    expect(html).toContain("older history not loaded");
    expect(html).not.toContain('<h2 id="b-chart-h">Calibration</h2>');
  });

  it("omits the 'Load older' control and heading qualifier when there are no older pages", () => {
    const html = renderDashboard([entry("e1"), entry("e2")], NONCE, {
      nextCursor: null,
    });
    expect(html).not.toContain('id="load-older"');
    expect(html).toContain('<h2 id="b-chart-h">Calibration</h2>');
  });
});

describe("renderConfigureKey", () => {
  it("emits the CSP + nonce shell but neither chart nor table", () => {
    const html = renderConfigureKey(NONCE);
    expect(html).toContain(`script-src 'nonce-${NONCE}';`);
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<table");
    expect(html).toContain("No API key configured");
    // The only external URL allowed is the key-issuance link (a navigation
    // target, never a loaded resource — no external src= is present).
    expect(html).not.toMatch(/src="https?:\/\//);
  });

  it("has a working #refresh (re-check) button, a key link, and a restart note", () => {
    const html = renderConfigureKey(NONCE);
    // The refresh script wires #refresh → postMessage; the button must exist.
    expect(html).toContain('id="refresh"');
    expect(html).toContain('postMessage({ type: "refresh" })');
    expect(html).toContain('href="https://budgetary.tools"');
    expect(html.toLowerCase()).toContain("restart");
  });
});

describe("renderConfigUnreadable", () => {
  it("names the broken file and is distinct from the no-key panel", () => {
    const html = renderConfigUnreadable("/home/u/.budgetary/config.json", NONCE);
    expect(html).toContain(`script-src 'nonce-${NONCE}';`);
    expect(html).toContain("Config file could not be read");
    expect(html).toContain("/home/u/.budgetary/config.json");
    // The whole point of this panel: it must NOT tell the user "no key".
    expect(html).not.toContain("No API key configured");
    expect(html).toContain('id="refresh"');
    expect(html).not.toContain("<svg");
  });

  it("escapes the path (never injects it raw into the HTML)", () => {
    const html = renderConfigUnreadable("<script>x</script>", NONCE);
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("renderError", () => {
  it("includes the message and the request_id when supplied", () => {
    const html = renderError("rate limited", "req_xyz", NONCE);
    expect(html).toContain("rate limited");
    expect(html).toContain("req_xyz");
    expect(html).not.toContain("<svg");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("omits the request_id block when null", () => {
    const html = renderError("network down", null, NONCE);
    expect(html).toContain("network down");
    expect(html).not.toContain("request_id:");
  });

  it("carries an aria-live status region (so a failed refresh isn't silent)", () => {
    expect(renderError("boom", null, NONCE)).toContain('id="b-status"');
    expect(renderConfigureKey(NONCE)).toContain('id="b-status"');
  });

  it("escapes HTML in the message", () => {
    const html = renderError("<script>alert(1)</script>", null, NONCE);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("renderLoading", () => {
  it("renders the loading shell without crashing", () => {
    const html = renderLoading(NONCE);
    expect(html).toContain("Loading your ledger");
    expect(html).toContain(`script-src 'nonce-${NONCE}';`);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
