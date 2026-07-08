import type { LedgerEntry } from "@budgetary/sdk";

import { escapeHtml } from "../format";
import { renderCalibrationChart } from "./chart";
import { renderRecentTable } from "./table";

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
  section.b-chart svg { width: 100%; height: auto; max-height: 480px; }
  .b-legend {
    display: flex;
    gap: 18px;
    margin-top: 12px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    flex-wrap: wrap;
  }
  .b-swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
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

const LEGEND = `<div class="b-legend">
  <span><span class="b-swatch" style="background: var(--vscode-charts-blue);"></span>confident</span>
  <span><span class="b-swatch" style="background: var(--vscode-charts-yellow);"></span>uncertain</span>
  <span><span class="b-swatch" style="background: var(--vscode-charts-orange);"></span>sparse_evidence</span>
  <span><span class="b-swatch" style="background: var(--vscode-foreground); opacity: 0.6;"></span>other</span>
  <span style="margin-left:auto;">dashed line: y = x (perfect calibration)</span>
</div>`;

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
${body}
</body>
</html>`;
}

function refreshScript(nonce: string): string {
  return `<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const btn = document.getElementById("refresh");
if (btn) btn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
</script>`;
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
  <section class="b-chart">
    ${renderCalibrationChart(entries)}
    ${LEGEND}
  </section>
  <section class="b-recent">
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
