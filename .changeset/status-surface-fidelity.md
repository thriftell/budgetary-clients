---
"@budgetary/mcp": patch
"budgetary-vscode": patch
---

Sharpen the status surfaces so they under-report trouble less and make the
`estimate_id` pairing key visible.

**@budgetary/mcp**
- `pending` rows now carry the facts that matter: `• <excerpt> — 3h ago,
  4/5 attempts, measured ✓, expires in ~1h, id est_ab12…`. `attempts` shows how
  close an entry is to the give-up cap; `measured ✓` marks an entry whose counts
  were already captured on a prior failed submit (a retry resends those); the
  expiry names the 24h auto-window and notes that manual `report-actual` still
  works past it.
- The `estimate_id` (short form) is now visible where it was invisible before:
  in the estimate render footer, in the manual/rollout submit confirmations, and
  on every `pending` row — the same short id across all three, so a user can
  correlate an estimate with its pending entry and its submission.
- `request_id` is threaded into the auth (401), permission (403), and
  rate-limit (429) renderers, matching the transport-error renderers.
- Honest terminal copy: an empty queue no longer claims "the loop is closed"
  (some estimates may have been dropped — gave-up / rejected / TTL-swept, which
  the last-run breadcrumb reports).

**budgetary-vscode**
- The dashboard surfaces the out-of-coverage void rate ("2 of the last 50
  estimates were out-of-coverage voids") from `scenario === "out_of_domain"`.
- Out-of-domain rows render their Result cell as "no prediction" instead of the
  misleading "○ pending" — a void never receives an actual.
- `out_of_domain` is dropped from the chart legend (it is never plotted as a
  marker, so its swatch advertised a shape the chart never draws); it still
  appears in the table's Scenario column.
