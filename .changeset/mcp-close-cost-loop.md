---
"@budgetary/mcp": minor
---

Close the forecast→actual cost loop for the human, and make the tier/limits legible.

The product promises "forecast X → you spent Y", but on the default Claude Code
auto path it never closed for a human who doesn't open the VS Code dashboard: the
actual was submitted silently and nothing local paired it against the forecast.

- **Persist the forecast band.** The pending entry now stores the estimate's
  `{p10,p50,p90}` (a LOCAL, v1-additive field — the estimate response already
  carried the band, so no wire change). The auto path stamps the realized
  `tokensIn/tokensOut` + that band into the session-end breadcrumb.
- **Render the loop.** `pending` and `doctor` now show
  "actual N tokens vs forecast ~M (within/above/below p10–p90)" on the last-run
  header; the `report-actual` and rollout success lines print the same forecast
  check; and each pending row shows its forecast (or actual-vs-forecast once
  measured). Tokens only — never a dollar figure.
- **Tier where the spend happens.** The estimate footer and the stderr startup
  banner now name the key tier (`bg_live_` paid / `bg_test_` free) — never the
  value — so free-vs-paid is visible at the point of spend, not only in `doctor`.
- **A store fault is no longer a second bill.** The `stored: false` footer prints
  the FULL `estimate_id` and leads with `report-actual --estimate-id <id>` (a new
  path that closes an already-billed estimate for free with no pending row),
  demoting "re-estimate" — which would bill again — to a last resort.
- **Richer 429 render.** The rate-limit message now surfaces the tier
  limit/remaining/reset (from the SDK's parsed `X-RateLimit-*`) and the
  attempts/elapsed ordeal, matching the transport-error renderer.
- **Estimate render + guards.** Names the p90 worst case and the "valid until"
  expiry (previously parsed-but-unshown); hints when an unexpired pending entry
  holds the identical query+project (a likely duplicate bill); and gates the
  eager `transcriptUnreadableReason` debug arg on `debug.enabled` so a no-usage
  abort no longer re-reads the whole transcript with `BUDGETARY_DEBUG` off.

No `/v1` / engine / wire change; no pricing or dollar figure anywhere.
