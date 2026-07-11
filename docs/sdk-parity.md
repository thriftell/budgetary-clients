# SDK parity checklist

The TypeScript SDK (`sdk/typescript`) and the Python SDK (`sdk/python`) are two
implementations of the **same** [`/v1` contract](./api-contract.md). They drift
silently when a behavior is changed in one and not the other — and a stale test
in the lagging SDK can even *certify* the drift. This checklist is the guard.

**Every PR that touches `sdk/**` must tick this list**, and any change to a row
below must land in **both** SDKs (or state explicitly why not) in the same PR or
a paired follow-up referenced from the PR body.

## Invariants that must match

| # | Invariant | TypeScript | Python |
|---|---|---|---|
| 1 | **Status → error class.** `401 → auth`, `403 → permission` (a **sibling** of auth — both extend the base error, *not* one under the other — so 401 and 403 stay distinguishable), `404 → not-found`, `400/409/413 → validation`, `429 → rate-limit`, `5xx → server`, other → base. | `errors.ts` + `http.ts` `_build_error` | `errors.py` + `_internal/http.py` `_build_error` |
| 2 | **Default retries = 4** (5 total attempts, contract §8). | `DEFAULT_MAX_RETRIES` in `client.ts` | `DEFAULT_MAX_RETRIES` in `client.py` |
| 3 | **Backoff schedule.** Exponential with `factor=2`, `initialDelay=1000ms`, full jitter, `maxDelay=60000ms`. Retry only on `5xx` + `429`. | `retry.ts` | `_internal/retry.py` |
| 4 | **Retry-After is a floor, clamped to `maxDelay`.** `delay = min(max(retryAfterMs, computed), maxDelay)`. A huge/hostile header can't stall for minutes. | `retry.ts` | `_internal/retry.py` |
| 5 | **Empty/whitespace `api_key` throws in the constructor** (before any request), not an opaque 401 later. | `client.ts` (throws `Error`) | `client.py` (raises `ValueError`) |
| 6 | **`normalizeScenario` / `normalize_scenario`** folds any label outside `{confident, uncertain, sparse_evidence, out_of_domain}` to `"uncertain"`. | `types.ts` | `types.py` |
| 7 | **Additive-field tolerance (contract §3).** An unknown field on a response object (nested or top-level) must not break parsing. | structural parse | `client.py` `_known(...)` filters nested `**` constructors |
| 8 | **Parse failure stays in-taxonomy.** A missing / non-JSON success body surfaces as `BudgetaryNetworkError`, never a raw `KeyError`/`TypeError`. | `http.ts` | `_internal/http.py` parse escape |
| 9 | **Idempotency.** `client_request_id`: unset → fresh UUID v4; `None`/`null` → omit; string → verbatim. | `idempotency.ts` | `_internal/idempotency.py` |
| 10 | **Metadata forwarded verbatim.** Only known protocol fields are transformed; caller keys reach the wire unchanged. | `http.ts` / `client.ts` | `client.py` `submit_actuals` |
| 11 | **Typed marker.** The package advertises inline types so downstream type-checkers see them. | `.d.ts` via dual-publish | `src/budgetary/py.typed` (must ship in the wheel) |
| 12 | **Retry-exhaustion diagnostics (additive).** On the final throw the retry wrapper stamps `attempts` (1-based) + `totalElapsedMs` / `total_elapsed_ms` onto the `BudgetaryError`; an optional `onRetry` / `on_retry` observer fires before each backoff (a throw from it is swallowed). | `retry.ts` sets fields + `RetryInfo`; `onRetry` on client options | `_internal/retry.py` sets fields; `on_retry` on client options (`OnRetry`) |

## Before you merge an `sdk/**` PR

- [ ] The change is reflected in **both** SDKs, or the PR body says why it's TS-only / Python-only.
- [ ] The rows above still hold; any changed row was updated in both.
- [ ] Tests assert the **new** behavior in both SDKs (no stale test left certifying the old behavior).
- [ ] Python: `pytest` and `mypy` (strict) pass; `py.typed` still ships in the built wheel.
- [ ] TypeScript: `pnpm -r build` + `pnpm -r test` pass; `attw --pack` is clean.
