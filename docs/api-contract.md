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
    { "tool": "Read", "tokens": 1820, "target": "9f3a0b1c2d4e" },
    { "tool": "Edit", "tokens": 910, "kind": "turn-split", "target": "9f3a0b1c2d4e" },
    { "tool": "Bash", "tokens": 910, "kind": "turn-split", "target": "pytest a1b2c3d4e5f6", "ok": false }
  ],
  "produced_changes": 3,
  "accepted_changes": 2,
  "external_symbols": 8,
  "unresolved_symbols": 1,
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
| `produced_changes` | integer ≥ 0 | no | Discrete count of successful file-mutating tool calls in the run (see below). Content-free — not lines, not diffs. |
| `accepted_changes` | integer ≥ 0 | no | Of those, how many were still present at session close; always `≤ produced_changes`. Sent only together with `produced_changes`. |
| `external_symbols` | integer ≥ 0 | no | Distinct external, top-level module imports across the run's produced Python (see below). Content-free — a count, no names. |
| `unresolved_symbols` | integer ≥ 0 | no | Of those, how many a static resolver found confidently absent; always `≤ external_symbols`. Sent only together with `external_symbols`. |
| `metadata` | object | no | Free-form, max 2 KB serialized. |

**`trace` — additive execution trace.** An ordered array of measured steps, each `{ "tool": string, "tokens": integer, "kind"?: string, "target"?: string, "ok"?: boolean }`:

- `tool` — the raw host tool name the step used (e.g. `Read`, `Edit`, `Bash`). Behavior only; no classification.
- `tokens` — realized token usage attributed to that step, on the **same cache-read-excluded basis** as `tokens_in`/`tokens_out`. Never model-supplied.
- `kind` — `"turn-split"` when the host reports usage per turn rather than per tool call and a single turn's measured tokens were split evenly across the several tool calls it contained. Absent for a one-tool turn (exact attribution).
- `target` — *optional, additive.* A **redacted** descriptor of what the step acted on. For a shell step it is `"<program> [<subcommand>] <digest>"` — the program name in the clear (the leading command token, e.g. `pytest`, `go`, `npm`; for a known driver the subcommand too, e.g. `go test`, `npm run`) followed by a **non-reversible** digest of the rest of the command. For a file tool it is a bare digest of the path. The `target` **never** carries a raw command, absolute path, file contents, or any argument — only the program name and an opaque equality key (two identical operations produce the same `target`, so the server can detect a repeated step). It is measured from the transcript, never model-supplied, and omitted when it cannot be derived safely or when the client opts out of trace detail.
- `ok` — *optional, additive.* The measured outcome of the step: `false` exactly when the host flagged the tool result an error, `true` when it flagged success. Omitted when the host flagged no outcome (e.g. a successful file read whose result carries no error flag). Measured, never assumed, never model-supplied.

The server uses `target` (program name) and `ok` to decompose more of the run — for example to lift test/build commands out of the generic-shell bucket and to recognize a failed step repeated as a retry. **The client still classifies nothing**: it forwards a program name, a digest, and an error flag; every phase label and verdict is computed server-side.

The trace is **optional and lossy-safe**: the server uses it for server-side execution-phase classification but never requires it. Any breakdown the server derives is returned additively on `GET /v1/ledger` under the §3 forward-compatibility rule (clients ignore response fields they don't recognize); this contract does not yet pin those response fields. Limits are **≤ 512 steps** and **≤ 16 KB** serialized; a `trace` that exceeds either, or is otherwise malformed, is **silently dropped** — the actuals are still recorded as if no trace were sent. `target`/`ok` are independently optional within a step: a client that can measure tokens but not a safe target (or an outcome) omits just those fields. Clients that cannot measure a reliable per-step trace omit the field and submit totals alone.

**`produced_changes` / `accepted_changes` — additive change accounting.** Two content-free integers that let the server report whether the run's spend converted into edits that *stuck* — an efficiency signal (cost-per-accepted "vs tasks like yours"), not a productivity verdict. They are **counts of file-mutating tool events, never lines, never content**: no path, diff, or change text is attached or implied.

- `produced_changes` — the number of **successful file-mutating tool calls** in the run (the `Edit`/`Write`/`MultiEdit` family), counted as **discrete events**. A failed or denied mutate does not count.
- `accepted_changes` — of those, how many were **still present at session close**. A produced change is decremented when a later successful edit/write to the **same file** superseded it within the session. This is a **conservative within-session survival proxy**: the client is content-blind (it has file identity and event order, not diffs), so it cannot tell a semantic revert from an unrelated later edit — and therefore refuses to claim the earlier change survived. It is `≤ produced_changes` by construction, and **under-counts rather than over-counts** acceptance. Reverts performed by *other* tools (`rm`, `git checkout`) are content-invisible and out of scope here; durable, cross-session persistence is a server-side concern measured over time, not fabricated on the client.

Both counts are **measured from the run's own edit events, never model-supplied** — there is no model-invokable tool that can write them. They are **sent only together**, and **omitted together** on hosts that expose no per-edit events (Cursor/Copilot/Codex today) or when the operator opts out of trace detail. A missing change signal never fails or alters the actuals submission — the token total is the contract; the counts are additive. The server computes any cost-per-accepted figure and verdict; **the client classifies, scores, and benchmarks nothing**.

**`external_symbols` / `unresolved_symbols` — additive structural-existence accounting.** Two content-free integers that let the server report how often, for tasks like this one, code **runs but references a symbol that doesn't exist**. They describe **structural existence only** — whether a referenced module is real — not semantic correctness, and not a per-file "you hallucinated" flag.

- `external_symbols` — the number of **distinct external, top-level module imports** across the run's produced `.py` files. A submodule (`os.path`) counts once under its top-level name (`os`); relative imports and the project's own local modules are excluded, so this is external references only.
- `unresolved_symbols` — of those, how many a **linter-grade static resolver** found **confidently absent** in the interpreter that produced them. The client reads the produced files locally, parses them (never runs them), and checks each top-level name with `importlib.util.find_spec`, which resolves a top-level name via the path finders **without importing or executing** the module. It is `≤ external_symbols` and **under-counts rather than over-counts**: a name is counted absent only when `find_spec` confidently returns none, and every ambiguity (unparseable file, conditional `try/except` or function-local import, resolver error) is treated as resolved. Deeper resolution — submodules, imported members (`from X import y`), attribute existence (`X.foo`) — is out of scope in v1 (it requires importing modules, which has side effects); Python is the only ecosystem measured today.

Both counts are **measured by a static resolver over observed artifacts, never model-supplied** — there is no model-invokable tool that can write them, and **no symbol name, import statement, file path, or line of code is ever transmitted; only the two integers are**. They are **sent only together**, and **omitted together** when resolution is not observable (no produced Python, no interpreter available, a resolver error or timeout) or when the operator opts out of trace detail. A missing structural signal never fails or alters the actuals submission — the token total is the contract; the counts are additive. The server turns them into a coverage-gated, regional rate; **the client classifies, scores, and benchmarks nothing**.

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
