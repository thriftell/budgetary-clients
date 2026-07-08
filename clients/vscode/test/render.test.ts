import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@budgetary/sdk";

import {
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
