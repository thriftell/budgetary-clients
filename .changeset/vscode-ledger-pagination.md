---
"budgetary-vscode": patch
---

Dashboard: reach the whole ledger, and stop making false global claims from the newest-50 window.

The pagination plumbing existed end-to-end (contract `next_cursor`, `LedgerPage.nextCursor`, `getLedger({ after })`) — except the dashboard's last hop, which fetched 50 entries and dropped `nextCursor`, so a user with 1,000 estimates could see only the newest 50 with the rest unreachable.

- **Load older.** `renderDashboard` now threads `page.nextCursor`; when non-null it renders a "Load older" control that fetches the next page and **dedup-appends by `estimateId`** (cursor pages shift as new estimates arrive mid-pagination). The extension holds the accumulated set across the full-document reloads, and a stale/disposed load can't corrupt it (guarded state commit). Plotted markers are capped (`MAX_PLOT_POINTS`) so the chart stays bounded as pages accumulate.
- **Honest windowing.** The chart's "No calibration data yet" was a false *global* claim from the newest-50 window (a host with 50 orphans up top saw it despite older completed pairs). It's now scoped when older pages exist, and the "Calibration" heading carries a window qualifier. The table's "Showing the N most recent" note is keyed on the real next-cursor + the actual rendered count (the hardcoded `ROW_CAP=50` heuristic — wrong at both boundaries — is gone).
- Docs: mirrored the TS README's pagination recipe into the Python SDK README.
