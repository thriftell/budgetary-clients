---
"@budgetary/sdk": minor
---

Request/retry correctness fixes in the HTTP layer:

- Free-form `metadata` on `submitActuals` now reaches the wire **verbatim** — only known protocol fields are snake-cased, so caller-owned keys (e.g. `toolCalls`) are no longer rewritten.
- A failed or stalled response-body read is now classified as a `BudgetaryNetworkError` instead of escaping as a raw, unclassified error.
- An oversized `Retry-After` is clamped to `maxDelay`, so a large or hostile header can no longer stall the client for minutes.
- 403 now raises a distinct `BudgetaryPermissionError` (previously folded into `BudgetaryAuthError`), so "your key lacks scope" is distinguishable from "bad key". `maxRetries` defaults to `4` (5 total attempts), matching the API contract.
