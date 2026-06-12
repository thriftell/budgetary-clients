# Budgetary API (v1)

## 1. Overview

The Budgetary API returns probabilistic pre-inference estimates of token spend for LLM queries, and accepts post-inference telemetry that improves future estimates.

- **Base URL:** `https://api.budgetary.tools`
- **Protocol:** HTTPS only
- **Content type:** `application/json; charset=utf-8` for both request and response bodies
- **Versioning:** path-prefixed (`/v1/...`)

## 2. Authentication

All endpoints except `GET /v1/health` require a bearer API key:

```
Authorization: Bearer bg_live_XXXXXXXXXXXXXXXXXXXXXXXX
```

Keys are issued per organization. The prefix denotes environment: `bg_live_` for production, `bg_test_` for the free testing tier. Requests with a missing or invalid key return `401 authentication_failed`.

## 3. Versioning policy

- The `/v1/` prefix is stable. Backward-compatible additions (new optional request fields, new optional response fields, new endpoints, new scenario labels, new error codes) may land in `/v1/` without notice.
- Breaking changes (removed fields, changed semantics, renamed scenarios) require a new version prefix (`/v2/`) and a minimum 12-month deprecation window during which both versions remain available.
- Clients should ignore unknown response fields rather than treating them as errors.

## 4. Endpoints

### 4.1 `POST /v1/estimate`

Returns a probabilistic estimate of total token spend (input + output) for the given query.

**Request**

```json
{
  "query": "fix the flaky test in the payments service",
  "model": "claude-opus-4-7",
  "context": {
    "host": "claude-code",
    "project_id": "proj_kx7...",
    "depth_budget": 50
  },
  "client_request_id": "req_uuid_for_idempotency"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Natural-language description of the task. Max 8 000 characters. |
| `model` | string | no | Target LLM model identifier. If omitted, server uses an org-default. Unknown values are accepted and treated as a hint. |
| `context.host` | string | no | One of `claude-code`, `codex`, `vscode`, `sdk`, or any free-form identifier. |
| `context.project_id` | string | no | Stable opaque ID for grouping estimates into the same logical project. |
| `context.depth_budget` | integer | no | Max agent iterations the caller intends to allow. Hint only. |
| `client_request_id` | string | no | Client-generated idempotency key. Identical replays within 24 hours return the same `estimate_id` and response. |

**Response — 200 OK**

```json
{
  "estimate_id": "est_01HXXXXXXXXXXXXXXXXXXXXXXX",
  "scenario": "confident",
  "void": false,
  "distribution": {
    "p10": 12500,
    "p50": 48000,
    "p90": 220000,
    "unit": "tokens"
  },
  "confidence": 0.74,
  "model": "claude-opus-4-7",
  "expires_at": "2026-05-27T10:14:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `estimate_id` | string | ULID. The join key for any subsequent `/v1/actuals` submission. |
| `scenario` | string | One of the labels in §5. Unknown values must be treated as `uncertain`. |
| `void` | boolean | When `true`, the server declined to estimate. `distribution` is `null`. |
| `distribution.p10`/`p50`/`p90` | integer | Combined input + output tokens at the 10th, 50th, 90th percentiles. |
| `distribution.unit` | string | Always `"tokens"` in v1. |
| `confidence` | number | `[0, 1]`. Single user-facing summary of estimate quality. |
| `model` | string | Echo of the resolved model. |
| `expires_at` | string | RFC 3339. Estimates older than this should be considered stale. |

A void response (`scenario: "out_of_domain"`, `void: true`, `distribution: null`) is **not an error**. Clients should render it as "we cannot confidently estimate this query."

### 4.2 `POST /v1/actuals`

Submits the realized token spend for a previously estimated query.

**Request**

```json
{
  "estimate_id": "est_01HXXXXXXXXXXXXXXXXXXXXXXX",
  "tokens_in": 12340,
  "tokens_out": 36210,
  "success": true,
  "duration_ms": 420000,
  "trace": [
    { "tool": "Read", "tokens": 1820 },
    { "tool": "Edit", "tokens": 910, "kind": "turn-split" },
    { "tool": "Bash", "tokens": 910, "kind": "turn-split" }
  ],
  "metadata": {
    "error": null,
    "tool_calls": 47
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `estimate_id` | string | yes | Must match a previously returned `estimate_id`. |
| `tokens_in` | integer | yes | Total input tokens across all model calls in the run. |
| `tokens_out` | integer | yes | Total output tokens across all model calls in the run. |
| `success` | boolean | yes | Whether the agent run completed its objective. |
| `duration_ms` | integer | yes | Wall-clock duration in milliseconds. |
| `trace` | array | no | Optional per-step execution trace (see below). |
| `metadata` | object | no | Free-form, max 2 KB serialized. |

**`trace` — additive execution trace.** An ordered array of measured steps, each `{ "tool": string, "tokens": integer, "kind"?: string }`:

- `tool` — the raw host tool name the step used (e.g. `Read`, `Edit`, `Bash`). Behavior only; no classification.
- `tokens` — realized token usage attributed to that step, on the **same cache-read-excluded basis** as `tokens_in`/`tokens_out`. Never model-supplied.
- `kind` — `"turn-split"` when the host reports usage per turn rather than per tool call and a single turn's measured tokens were split evenly across the several tool calls it contained. Absent for a one-tool turn (exact attribution).

The trace is **optional and lossy-safe**: the server uses it for server-side execution-phase classification but never requires it. Any breakdown the server derives is returned additively on `GET /v1/ledger` under the §3 forward-compatibility rule (clients ignore response fields they don't recognize); this contract does not yet pin those response fields. Limits are **≤ 512 steps** and **≤ 16 KB** serialized; a `trace` that exceeds either, or is otherwise malformed, is **silently dropped** — the actuals are still recorded as if no trace were sent. Clients that cannot measure a reliable per-step trace omit the field and submit totals alone.

**Response — 202 Accepted**

```json
{ "received": true, "ledger_entry_id": "led_01HZZZZZZZZZZZZZZZZZZZZZ" }
```

Idempotent on `estimate_id`. Resubmission returns 202 with the original `ledger_entry_id`. Unknown `estimate_id` returns `404 not_found`.

### 4.3 `GET /v1/ledger`

Paginated history of estimates joined with actuals.

**Query parameters**

| Param | Type | Notes |
|---|---|---|
| `project_id` | string | Filter to a single project. |
| `host` | string | Filter to a single client host. |
| `after` | string | Cursor for forward pagination. |
| `limit` | integer | Default 50, max 200. |
| `include_orphans` | boolean | Default `false`. When `true`, include estimates with no matching actuals. |
| `since` | string | RFC 3339 timestamp lower bound. |

**Response — 200 OK**

```json
{
  "entries": [
    {
      "estimate_id": "est_01HXX...",
      "created_at": "2026-05-26T03:14:00Z",
      "query_excerpt": "fix the flaky test in the payments service",
      "model": "claude-opus-4-7",
      "host": "claude-code",
      "project_id": "proj_kx7...",
      "scenario": "confident",
      "predicted": { "p10": 12500, "p50": 48000, "p90": 220000 },
      "actual": {
        "tokens_in": 12340,
        "tokens_out": 36210,
        "total": 48550,
        "duration_ms": 420000,
        "success": true
      }
    }
  ],
  "next_cursor": "est_01HXY..."
}
```

`actual` is `null` if no actuals submission exists yet (only returned when `include_orphans=true`). `next_cursor` is `null` when no further pages exist. `query_excerpt` is the first 120 characters of the original query.

### 4.4 `GET /v1/health`

Unauthenticated liveness probe.

```json
{ "status": "ok", "version": "v1" }
```

## 5. Scenario labels (v1)

| Label | Meaning |
|---|---|
| `confident` | The estimate is well-supported. The distribution is reliable. |
| `uncertain` | The estimate is supported but the distribution is wide. |
| `sparse_evidence` | The query is near the edge of what's been seen before. |
| `out_of_domain` | The query is too far from anything seen. Returned with `void=true`. |

Future labels may be added. Clients should treat unknown values as `uncertain`.

## 6. Error model

All non-2xx responses use this shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "context.depth_budget must be a non-negative integer",
    "request_id": "req_01HABC..."
  }
}
```

| HTTP | `error.code` | When |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON, missing required field, field out of range. |
| 401 | `authentication_failed` | Missing, malformed, or revoked API key. |
| 403 | `permission_denied` | Key is valid but lacks scope. |
| 404 | `not_found` | Referenced resource does not exist or is not visible to this key. |
| 409 | `idempotency_conflict` | Same `client_request_id` was used with different parameters. |
| 413 | `payload_too_large` | `query` or `metadata` exceeds the documented size limit. |
| 429 | `rate_limited` | Tier rate limit exceeded. |
| 500 | `internal_error` | Server-side failure. |
| 503 | `unavailable` | Server is in maintenance or degraded mode. |

`request_id` is always present.

## 7. Rate limits

Rate-limited responses include:

```
X-RateLimit-Limit:     <int>
X-RateLimit-Remaining: <int>
X-RateLimit-Reset:     <unix-epoch-seconds>
Retry-After:           <seconds>   (on 429 only)
```

## 8. Idempotency and retries

- `POST /v1/estimate`: pass `client_request_id` (any unique string up to 128 chars). Identical replays within 24 h return the original response without rebilling.
- `POST /v1/actuals`: idempotent on `estimate_id`. Safe to retry on network failure.
- All endpoints: clients should retry `5xx` and `429` responses with exponential backoff (initial 1 s, factor 2, jitter, max 60 s, give up after 5 attempts).

## 9. Stability guarantees

- Field names, value types, and HTTP status codes are stable for the life of `/v1/`.
- Numerical values are server-computed and may shift as the model improves; not guaranteed to be reproducible bit-for-bit.
- `estimate_id` and `ledger_entry_id` are opaque tokens; do not parse them.
