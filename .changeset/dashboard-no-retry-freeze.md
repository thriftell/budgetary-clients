---
"budgetary-vscode": patch
---

Keep the dashboard responsive when the ledger call fails. The webview now builds
its `BudgetaryClient` with `maxRetries: 0`: a `429 Retry-After` (clamped to 60 s)
or a 5xx retry ladder would otherwise pin the panel on "Loading…" for up to
~4 minutes before showing anything. The visible Retry/refresh button IS the
retry, so the failure now surfaces promptly. The ledger response is also
shape-guarded — a malformed page (`entries` not an array) reads as an honest
"unexpected response" instead of throwing out of the renderer.
