---
"budgetary-vscode": patch
---

Dashboard: answer "what am I spending?", and stop retaining the hidden webview.

- **Cost summary strip.** A one-line summary above the calibration chart,
  computed client-side from the already-loaded page: "N estimates loaded: X
  tokens actual vs ~Y forecast (median Z× actual/forecast); K pending, V voids"
  (plus a distinct-project count when the view spans several). Tokens only — the
  ledger carries no price, so it never shows a dollar figure. Honest about the
  window: when older pages exist it says "most recent; older history not loaded",
  so the totals are never read as the whole ledger. The chart/table answered "was
  each estimate right?"; this answers "what am I spending?".
- **Drop `retainContextWhenHidden`.** The extension already holds all pagination
  state and every render rewrites the whole document, so retaining a 5–30 MB
  webview for the whole session only bought scroll restore (which the webview's
  own getState/setState already handles). The dashboard now re-renders from the
  held state on `onDidChangeViewState` when it returns to view — no server
  round-trip — for a fraction of the memory.
