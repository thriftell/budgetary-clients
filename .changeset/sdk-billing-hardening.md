---
"@budgetary/sdk": minor
---

Billing-hardening for the retry/rate-limit path (TypeScript SDK; the Python SDK
carries the same changes for parity — it versions separately).

- **Fail fast when `Retry-After` exceeds the max backoff.** When a 429's
  `Retry-After` is longer than the largest single backoff the ladder would ever
  sleep (`maxDelayMs`, default 60 s), the SDK no longer sleeps the clamped delay
  and retries — which would fire *before* the server's stated success time, a
  guaranteed second 429 that wastes an attempt and hammers a strained engine.
  It now propagates `BudgetaryRateLimitError` immediately, with
  `retryAfterSeconds` intact, so the caller can honor the full wait. Waits that
  fit within the budget still retry (the floor is honored) exactly as before.
- **Parse the rate-limit window (contract §7).** A 429 now populates
  `BudgetaryRateLimitError.limit` / `.remaining` / `.resetSeconds` from
  `X-RateLimit-Limit` / `-Remaining` / `-Reset` (unix epoch seconds), when the
  server sends them (all default to `null`). Additive — the only header read
  before was `Retry-After`.
- **Reject an empty/whitespace query locally.** `estimate("")` (or all-whitespace)
  now throws `BudgetaryValidationError` (`httpStatus: null`) without a request —
  it can only earn a billed 400. Mirrors the MCP tool's existing trim-guard.

No wire/contract change. The idempotency key is still resolved once, outside the
retry loop (a new test pins that retries replay one identical `client_request_id`,
so a refactor can't silently re-bill).
