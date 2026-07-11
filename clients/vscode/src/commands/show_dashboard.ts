import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import {
  BudgetaryAuthError,
  BudgetaryClient,
  BudgetaryError,
  type LedgerEntry,
} from "@budgetary/sdk";

import { resolveConfigStatus } from "../config";
import {
  renderConfigUnreadable,
  renderConfigureKey,
  renderDashboard,
  renderError,
  renderLoading,
} from "../webview/render";

/** Entries fetched per ledger page. Load-older appends the next page of this size. */
const LEDGER_LIMIT = 50;

let panel: vscode.WebviewPanel | undefined;
// Monotonic load counter: every load() captures the value it started with, and
// only writes to the webview while it is still the latest — see load().
let loadGeneration = 0;

// Accumulated pagination state. A fresh load / refresh resets both; "Load older"
// fetches the next page (via `cursor`) and appends to `accumulated` (deduped by
// estimateId, since cursor pages shift as new estimates arrive mid-pagination).
// The extension MUST hold this — each render reloads the whole webview document,
// so the webview can't retain it.
let accumulated: LedgerEntry[] = [];
let cursor: string | null = null;
// Whether the DASHBOARD (not the loading / configure / error view) is what the
// panel currently shows. Gates the view-state re-render below so a hide during
// the first load, or while an error/configure panel is up, isn't clobbered with
// a (possibly empty) dashboard. Reset when the panel is disposed.
let dashboardVisible = false;

function makeNonce(): string {
  return randomBytes(16).toString("base64").replace(/[+/=]/g, "");
}

/** Append `incoming` to `existing`, skipping any estimateId already present. */
function dedupAppend(
  existing: readonly LedgerEntry[],
  incoming: readonly LedgerEntry[],
): LedgerEntry[] {
  const seen = new Set(existing.map((e) => e.estimateId));
  const merged = existing.slice();
  for (const e of incoming) {
    if (!seen.has(e.estimateId)) {
      seen.add(e.estimateId);
      merged.push(e);
    }
  }
  return merged;
}

/** Reset pagination state (on dispose, so a reopened panel starts clean). */
function resetPagination(): void {
  accumulated = [];
  cursor = null;
  dashboardVisible = false;
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
      // Deliberately NO `retainContextWhenHidden`: the extension already holds all
      // pagination state (`accumulated` + `cursor`) and every render rewrites the
      // whole document, so retaining a 5–30 MB webview for the whole session only
      // bought scroll restore — which the webview's own getState/setState already
      // handles. Instead we re-render from the held state when the panel returns to
      // view (see onDidChangeViewState below), for a fraction of the memory.
      // The CSP nailed in our HTML already blocks remote resources; we don't
      // need to enable localResourceRoots because we don't serve any.
      localResourceRoots: [],
    },
  );

  panel.onDidDispose(() => {
    panel = undefined;
    resetPagination();
  });

  // Without retainContextWhenHidden the webview is torn down while hidden. When it
  // returns to view, re-render the dashboard from the pagination state the
  // extension holds — no server round-trip (a fresh nonce guarantees VS Code
  // reloads the document). Guarded on `dashboardVisible` so a hide during the
  // first load, or while the configure/error panel is up, isn't overwritten.
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.visible && panel === e.webviewPanel && dashboardVisible) {
      e.webviewPanel.webview.html = renderDashboard(accumulated, makeNonce(), {
        nextCursor: cursor,
      });
    }
  });

  panel.webview.onDidReceiveMessage((msg) => {
    const type =
      msg && typeof msg === "object" ? (msg as { type?: unknown }).type : undefined;
    if (type === "refresh") {
      // A manual refresh keeps the current view (no full "Loading…" blank); the
      // webview announces "Refreshing…" via aria-live and restores focus/scroll.
      if (panel) void load(panel, { isRefresh: true });
    } else if (type === "loadMore") {
      // "Load older": fetch + append the next page without blanking the view.
      if (panel) void load(panel, { loadMore: true });
    }
  });

  void load(panel);
}

export async function load(
  p: vscode.WebviewPanel,
  opts: { isRefresh?: boolean; loadMore?: boolean } = {},
): Promise<void> {
  // Newest-wins + disposed guard. A ledger fetch can resolve after a newer
  // refresh started, or after the panel was disposed. `apply` writes only while
  // this load is still the latest AND `p` is still the active panel — so a stale
  // response can't clobber fresher content, and a resolve on a disposed panel
  // can't throw (VS Code throws when you set `.html` on a disposed webview).
  const generation = ++loadGeneration;
  const isCurrent = (): boolean => generation === loadGeneration && panel === p;
  // `isDashboard` records whether the applied view is the dashboard (vs a
  // loading / configure / error interstitial), so the view-state re-render only
  // fires for the dashboard. Set inside the isCurrent guard so a stale load can't
  // flip the flag after a newer render won.
  const apply = (html: string, isDashboard = false): void => {
    if (isCurrent()) {
      dashboardVisible = isDashboard;
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

  // A "Load older" request with no cursor is a no-op (the button only renders
  // when one exists, but guard against a stale click after the last page).
  if (opts.loadMore && cursor === null) return;

  // A manual refresh / load-older keeps the current dashboard visible (no full
  // "Loading…" blank that would lose scroll/focus); the webview announces via
  // aria-live. Only the first paint shows the loading interstitial.
  if (!opts.isRefresh && !opts.loadMore) apply(renderLoading(makeNonce()));

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
    // Load-older passes the cursor captured at call time as `after`.
    const after = opts.loadMore ? (cursor ?? undefined) : undefined;
    const page = await client.getLedger({
      limit: LEDGER_LIMIT,
      includeOrphans: true,
      ...(after !== undefined ? { after } : {}),
    });
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
    // Commit pagination state only while still current, so a stale load (a newer
    // refresh started, or the panel was disposed) can't corrupt the accumulated
    // set. A fresh load / refresh replaces it; load-older dedup-appends.
    if (!isCurrent()) return;
    const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    accumulated = opts.loadMore
      ? dedupAppend(accumulated, page.entries)
      : page.entries.slice();
    cursor = nextCursor;
    apply(renderDashboard(accumulated, makeNonce(), { nextCursor: cursor }), true);
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
