import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { BudgetaryAuthError, BudgetaryClient, BudgetaryError } from "@budgetary/sdk";

import { resolveConfigStatus } from "../config";
import {
  renderConfigUnreadable,
  renderConfigureKey,
  renderDashboard,
  renderError,
  renderLoading,
} from "../webview/render";

let panel: vscode.WebviewPanel | undefined;
// Monotonic load counter: every load() captures the value it started with, and
// only writes to the webview while it is still the latest — see load().
let loadGeneration = 0;

function makeNonce(): string {
  return randomBytes(16).toString("base64").replace(/[+/=]/g, "");
}

export function showDashboard(_context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    void load(panel);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "budgetary.dashboard",
    "Budgetary Dashboard",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      // The CSP nailed in our HTML already blocks remote resources; we don't
      // need to enable localResourceRoots because we don't serve any.
      localResourceRoots: [],
    },
  );

  panel.onDidDispose(() => {
    panel = undefined;
  });

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "refresh") {
      // A manual refresh keeps the current view (no full "Loading…" blank); the
      // webview announces "Refreshing…" via aria-live and restores focus/scroll.
      if (panel) void load(panel, { isRefresh: true });
    }
  });

  void load(panel);
}

export async function load(
  p: vscode.WebviewPanel,
  opts: { isRefresh?: boolean } = {},
): Promise<void> {
  // Newest-wins + disposed guard. A ledger fetch can resolve after a newer
  // refresh started, or after the panel was disposed. `apply` writes only while
  // this load is still the latest AND `p` is still the active panel — so a stale
  // response can't clobber fresher content, and a resolve on a disposed panel
  // can't throw (VS Code throws when you set `.html` on a disposed webview).
  const generation = ++loadGeneration;
  const apply = (html: string): void => {
    if (generation === loadGeneration && panel === p) {
      p.webview.html = html;
    }
  };

  const status = resolveConfigStatus();
  if (status.kind === "no-key") {
    apply(renderConfigureKey(makeNonce()));
    return;
  }
  if (status.kind === "unreadable") {
    // A config file that exists but can't be parsed is a distinct, fixable
    // problem from "no key" — say so, rather than telling the user to set a key.
    apply(renderConfigUnreadable(status.path, makeNonce()));
    return;
  }
  const config = status.config;

  // A manual refresh keeps the current dashboard visible (no full "Loading…"
  // blank that would lose scroll/focus); the webview announces "Refreshing…"
  // via aria-live. Only the first paint shows the loading interstitial.
  if (!opts.isRefresh) apply(renderLoading(makeNonce()));

  const client = new BudgetaryClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    // No in-process retry: a 429 `Retry-After` (clamped to 60 s) or a 5xx ladder
    // would pin the panel on "Loading…" for up to ~4 minutes. The visible
    // Retry/refresh button IS the retry — surface the failure promptly instead.
    maxRetries: 0,
  });

  try {
    // includeOrphans: pending estimates have no actuals yet; show them as rows
    // rather than hiding them (and mislabeling a non-empty ledger "No estimates").
    const page = await client.getLedger({ limit: 50, includeOrphans: true });
    // Guard the response shape: a malformed page (entries not an array) must
    // read as an honest "unexpected response", never throw out of the renderer.
    if (!page || !Array.isArray(page.entries)) {
      apply(
        renderError(
          "Budgetary returned an unexpected response. Please try again.",
          null,
          makeNonce(),
        ),
      );
      return;
    }
    apply(renderDashboard(page.entries, makeNonce()));
  } catch (err) {
    const nonce = makeNonce();
    if (err instanceof BudgetaryAuthError) {
      // A rejected key (401) is a configuration problem, not a transient error —
      // show the configure-key panel (with its re-check button) so the user can
      // fix and retry, instead of a generic "could not load ledger".
      apply(renderConfigureKey(nonce));
    } else if (err instanceof BudgetaryError) {
      apply(renderError(err.message, err.requestId, nonce));
    } else {
      apply(
        renderError(
          err instanceof Error ? err.message : String(err),
          null,
          nonce,
        ),
      );
    }
  }
}
