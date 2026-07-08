import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { BudgetaryAuthError, BudgetaryClient, BudgetaryError } from "@budgetary/sdk";

import { resolveConfig } from "../config";
import {
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

  const config = resolveConfig();
  if (config === null) {
    apply(renderConfigureKey(makeNonce()));
    return;
  }

  // A manual refresh keeps the current dashboard visible (no full "Loading…"
  // blank that would lose scroll/focus); the webview announces "Refreshing…"
  // via aria-live. Only the first paint shows the loading interstitial.
  if (!opts.isRefresh) apply(renderLoading(makeNonce()));

  const client = new BudgetaryClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  try {
    // includeOrphans: pending estimates have no actuals yet; show them as rows
    // rather than hiding them (and mislabeling a non-empty ledger "No estimates").
    const page = await client.getLedger({ limit: 50, includeOrphans: true });
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
