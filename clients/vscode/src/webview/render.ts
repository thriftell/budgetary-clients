import type { LedgerEntry } from "@budgetary/sdk";

import { escapeHtml } from "../format";
import { CHART_SUMMARY_ID, renderCalibrationChart } from "./chart";
import { renderRecentTable } from "./table";
import { LEGEND_STYLES, legendSwatchSvg } from "./scenario";

const STYLES = `
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 24px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  header.b-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    padding-bottom: 12px;
  }
  header.b-header h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 500;
    color: var(--vscode-foreground);
  }
  .b-subtitle {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-left: 12px;
  }
  p.b-stat {
    margin: 0 0 16px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  button.b-refresh {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
    padding: 4px 12px;
    font-family: inherit;
    font-size: inherit;
    border-radius: 2px;
    cursor: pointer;
  }
  button.b-refresh:hover { background: var(--vscode-button-hoverBackground); }
  section.b-chart {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 16px;
    margin-bottom: 24px;
    background: var(--vscode-editorWidget-background);
  }
  /* Only the chart itself (a direct child) stretches — not legend swatch SVGs. */
  section.b-chart > svg { width: 100%; height: auto; max-height: 480px; }
  .b-legend-mark { width: 14px; height: 14px; }
  section h2 {
    margin: 0 0 12px;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  .b-visually-hidden {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  .b-legend {
    display: flex;
    gap: 18px;
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    flex-wrap: wrap;
  }
  .b-legend li { display: flex; align-items: center; }
  .b-legend-mark { margin-right: 6px; vertical-align: middle; }
  .b-legend-note { margin-left: auto; }
  .b-caption {
    caption-side: top;
    text-align: left;
    padding: 0 0 8px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  table.b-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  table.b-table th, table.b-table td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    text-align: left;
  }
  table.b-table th {
    font-weight: 600;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 11px;
  }
  table.b-table tbody tr:nth-child(even) {
    background: var(--vscode-list-hoverBackground);
  }
  td.b-cell-num { text-align: right; font-variant-numeric: tabular-nums; }
  td.b-cell-done { text-align: center; }
  td.b-cell-when { white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; }
  td.b-cell-query { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.b-cell-scenario { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  td.b-cell-id { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--vscode-descriptionForeground); }
  .b-empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .b-message {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 24px;
    background: var(--vscode-editorWidget-background);
  }
  .b-message h2 { margin-top: 0; font-size: 16px; font-weight: 500; }
  .b-message code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 6px;
    border-radius: 2px;
  }
  .b-request-id {
    margin-top: 16px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
  }
`;

// Built from the single shared source of truth (scenario.ts), so the legend's
// colors AND shapes always match the chart markers — including out_of_domain.
const LEGEND = `<ul class="b-legend" aria-label="Scenario legend">
  ${LEGEND_STYLES.map(
    (s) => `<li>${legendSwatchSvg(s)}<span>${escapeHtml(s.label)}</span></li>`,
  ).join("\n  ")}
  <li class="b-legend-note">dashed line: y = x (perfect calibration)</li>
</ul>`;

function shell(nonce: string, title: string, body: string): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
<div class="b-visually-hidden" id="b-status" role="status" aria-live="polite"></div>
${body}
</body>
</html>`;
}

/**
 * Wires the #refresh button and preserves context across the full-document
 * reload each refresh performs: scroll position and button focus are saved to
 * (and restored from) the webview state, and an aria-live region announces
 * "Refreshing…" / "Dashboard updated" so the reload isn't silent to a screen
 * reader. Guarded by `if (btn)` so panels without a refresh button are inert.
 */
function refreshScript(nonce: string): string {
  return `<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const prev = vscode.getState() || {};
  const status = document.getElementById("b-status");
  if (typeof prev.scrollY === "number") window.scrollTo(0, prev.scrollY);
  if (prev.pendingRefresh) {
    // Announce honestly: the dashboard rendered (has the chart heading) → updated;
    // otherwise the refresh landed on an error/configure page → say so.
    const ok = !!document.getElementById("b-chart-h");
    if (status) status.textContent = ok ? "Dashboard updated." : "Refresh didn't complete — see the message.";
    vscode.setState(Object.assign({}, vscode.getState() || {}, { pendingRefresh: false }));
  }
  const btn = document.getElementById("refresh");
  if (btn) {
    if (prev.refreshFocused) {
      btn.focus();
      // Consume the flag so a later, unrelated reload doesn't steal focus back.
      vscode.setState(Object.assign({}, vscode.getState() || {}, { refreshFocused: false }));
    }
    btn.addEventListener("click", function () {
      vscode.setState({ scrollY: window.scrollY, refreshFocused: true, pendingRefresh: true });
      if (status) status.textContent = "Refreshing…";
      vscode.postMessage({ type: "refresh" });
    });
  }
  window.addEventListener("scroll", function () {
    const s = vscode.getState() || {};
    s.scrollY = window.scrollY;
    vscode.setState(s);
  }, { passive: true });
})();
</script>`;
}

/**
 * A one-line coverage stat: how many of the fetched estimates were out-of-domain
 * VOIDS (no prediction). Empty when there are none — a stat only worth surfacing
 * when there is something to surface, and one that explains why some rows read
 * "no prediction" instead of a calibration point.
 */
function voidRateNote(entries: readonly LedgerEntry[]): string {
  const voids = entries.filter((e) => e.scenario === "out_of_domain").length;
  if (voids === 0) return "";
  const wasWere = voids === 1 ? "was an out-of-coverage void" : "were out-of-coverage voids";
  return `<p class="b-stat">${voids} of the last ${entries.length} estimates ${wasWere} (no prediction — Budgetary declined to estimate).</p>`;
}

export function renderDashboard(
  entries: readonly LedgerEntry[],
  nonce: string,
): string {
  const body = `
  <header class="b-header">
    <div>
      <h1>Budgetary <span class="b-subtitle">predicted vs. actual</span></h1>
    </div>
    <button class="b-refresh" id="refresh" type="button">⟳ Refresh</button>
  </header>
  ${voidRateNote(entries)}
  <section class="b-chart" aria-labelledby="b-chart-h">
    <h2 id="b-chart-h">Calibration</h2>
    ${renderCalibrationChart(entries)}
    <p class="b-visually-hidden" id="${CHART_SUMMARY_ID}">Each mark plots one estimate's predicted midpoint (x) against its actual token total (y), on logarithmic scales; the dashed diagonal is perfect calibration and the horizontal whisker is the p10–p90 range. The same estimates are listed in the table below.</p>
    ${LEGEND}
  </section>
  <section class="b-recent" aria-labelledby="b-recent-h">
    <h2 id="b-recent-h">Recent estimates</h2>
    ${renderRecentTable(entries)}
  </section>
  ${refreshScript(nonce)}`;
  return shell(nonce, "Budgetary Dashboard", body);
}

export function renderConfigureKey(nonce: string): string {
  const body = `
  <header class="b-header">
    <h1>Budgetary <span class="b-subtitle">configure your key</span></h1>
    <button class="b-refresh" id="refresh" type="button">↻ I've set my key — re-check</button>
  </header>
  <div class="b-message">
    <h2>No API key configured</h2>
    <p>The Budgetary dashboard reads your ledger from the hosted API and needs an API key. Get one at <a href="https://budgetary.tools">budgetary.tools</a>, then set it one of two ways:</p>
    <p><strong>1. Config file at <code>~/.budgetary/config.json</code></strong> — recommended; shared with the Claude Code and Codex clients, so you set it once:</p>
    <p><code>{ "api_key": "bg_live_..." }</code></p>
    <p><strong>2. Environment variable</strong> <code>export BUDGETARY_API_KEY=bg_live_...</code> — note VS Code must be <strong>restarted</strong> (or launched from that shell) to pick up a new environment variable.</p>
    <p>Then press <strong>re-check</strong> above.</p>
  </div>
  ${refreshScript(nonce)}`;
  return shell(nonce, "Budgetary — Configure Key", body);
}

// Distinct from renderConfigureKey: the config file EXISTS but couldn't be read
// (invalid JSON, permissions). Telling the user "No API key configured" here is
// wrong — they may have set a key the file just can't be parsed for. Name the
// real problem so they fix the file instead of re-entering a key.
export function renderConfigUnreadable(path: string, nonce: string): string {
  const body = `
  <header class="b-header">
    <h1>Budgetary <span class="b-subtitle">config unreadable</span></h1>
    <button class="b-refresh" id="refresh" type="button">↻ I've fixed it — re-check</button>
  </header>
  <div class="b-message">
    <h2>Config file could not be read</h2>
    <p>Budgetary found <code>${escapeHtml(path)}</code> but couldn't read it — it may contain invalid JSON. Fix that file, or remove it and set <code>BUDGETARY_API_KEY</code> instead, then press <strong>re-check</strong> above.</p>
    <p>Get a key at <a href="https://budgetary.tools">budgetary.tools</a>.</p>
  </div>
  ${refreshScript(nonce)}`;
  return shell(nonce, "Budgetary — Config Unreadable", body);
}

export function renderError(
  message: string,
  requestId: string | null,
  nonce: string,
): string {
  const requestIdBlock = requestId
    ? `<p class="b-request-id">request_id: ${escapeHtml(requestId)}</p>`
    : "";
  const body = `
  <header class="b-header">
    <h1>Budgetary <span class="b-subtitle">error</span></h1>
    <button class="b-refresh" id="refresh" type="button">⟳ Retry</button>
  </header>
  <div class="b-message">
    <h2>Could not load ledger</h2>
    <p>${escapeHtml(message)}</p>
    ${requestIdBlock}
  </div>
  ${refreshScript(nonce)}`;
  return shell(nonce, "Budgetary — Error", body);
}

export function renderLoading(nonce: string): string {
  const body = `
  <header class="b-header">
    <h1>Budgetary <span class="b-subtitle">loading…</span></h1>
  </header>
  <div class="b-message"><p>Loading your ledger…</p></div>
  ${refreshScript(nonce)}`;
  return shell(nonce, "Budgetary Dashboard", body);
}
