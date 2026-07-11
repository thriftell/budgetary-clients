---
"@budgetary/sdk": minor
"@budgetary/mcp": patch
---

Make a retry ordeal legible instead of opaque (O-6).

**@budgetary/sdk (both TypeScript and Python)**
- On the final throw, the retry wrapper now stamps two additive, diagnostic
  fields onto the `BudgetaryError`: `attempts` (1-based — `1` for a first-attempt
  terminal failure, up to `maxRetries + 1` on exhaustion) and `totalElapsedMs` /
  `total_elapsed_ms` (wall-clock across every attempt + backoff). A ~4-minute
  429/5xx backoff no longer reads as a first-attempt blip. The error type is
  unchanged.
- An optional `onRetry` / `on_retry` observer on the client options fires before
  each backoff sleep with the attempt count, the delay about to be slept, and the
  HTTP status. Purely diagnostic — a throw from it is swallowed and never derails
  the request. (`RetryInfo` / `OnRetry` are exported for typing.)
- **TypeScript only:** `mapNetworkError` now appends `err.cause?.message` and the
  target **host** to the message, so a transport failure surfaces the real reason
  (`connect ECONNREFUSED …`) and where it was headed instead of the opaque
  `"fetch failed"`. (Python already interpolated this.) Host only — never the
  path/query.

**@budgetary/mcp**
- The estimate tool's transport-error render shows "after N attempts over Ns"
  when the SDK exhausted its ladder, so a slow retry ordeal is visible in the host.
