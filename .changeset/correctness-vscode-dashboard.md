---
"budgetary-vscode": patch
---

Dashboard correctness fixes:

- The calibration chart escapes the scenario label in point tooltips and looks up scenario colors as own-properties only, so an unusual label can't break the SVG.
- Pending (not-yet-completed) estimates are shown as rows instead of the dashboard reporting "No estimates yet" on a non-empty ledger.
- Concurrent and refresh loads are sequenced (newest-wins) and guarded against a disposed panel, so a slow response can't overwrite newer content or throw.
- The recent-estimates table tolerates an unparseable date without breaking its sort order.
