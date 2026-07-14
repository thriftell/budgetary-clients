# Budgetary API (v1)

## 1. Overview

The Budgetary API returns probabilistic pre-inference estimates of token spend for LLM queries, and accepts post-inference telemetry that improves future estimates.

- **Base URL:** `https://api.budgetary.tools`
- **Protocol:** HTTPS only
- **Content type:** `application/json; charset=utf-8` for both request and response bodies
- **Versioning:** path-prefixed (`/v1/...`)

## 2. Authentication

All endpoints except `GET /v1/health`, `GET /v1/meta` (see §4.6), and `POST /v1/webhooks/stripe` (which is authenticated by the Stripe webhook signature — see §4.5) require a bearer API key:

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
    "depth_budget": 50,
    "language": "TypeScript"
  },
  "client_request_id": "req_uuid_for_correlation"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Natural-language description of the task. Max 8 000 characters. |
| `model` | string | no | Target LLM model identifier (e.g., `claude-opus-4-7`, `claude-sonnet-4-6`, `gpt-5`). If omitted, the server applies its default model. **Recorded and echoed back in the response, but does not currently influence the estimate** — the estimate is model-agnostic today; the value is captured for possible future model-conditioning. |
| `context.host` | string | no | One of `claude-code`, `codex`, `vscode`, `sdk`, or any free-form identifier. Used for analytics and ledger grouping. |
| `context.project_id` | string | no | Stable opaque ID for grouping estimates into the same logical project on the ledger. |
| `context.depth_budget` | integer | no | Max agent iterations the caller intends to allow. **Accepted but currently ignored** — reserved; it does not influence the estimate today. |
| `context.language` | string | no | Optional programming language the task is for (e.g. `TypeScript`, `Python`). A **declared** tag — supply it from your editor/host environment, not a model guess; it is never inferred from `query`. Normalized server-side (aliases like `ts` → `TypeScript`); omit it when unknown. Used for analytics/segmentation, like `host`. (0022, additive.) |
| `client_request_id` | string | no | Optional client-generated correlation id (max 128 chars). **Accepted but currently ignored — it does not provide idempotent replay.** A retry with the same `client_request_id` produces a **new** `estimate_id`, recomputes, and is billed as a separate estimate. (True idempotent replay is a named future feature; see §8.) |

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
  "band": {
    "low": 0,
    "high": 300000,
    "label": "<300k",
    "unit": "tokens"
  },
  "confidence": 0.74,
  "model": "claude-opus-4-7",
  "expires_at": "2026-05-27T10:14:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `estimate_id` | string | ULID. The join key for any subsequent `/v1/actuals` submission. Always returned, even when `void = true`. |
| `scenario` | string | One of the labels in §5. May expand over time; clients must treat unknown values as `uncertain`. |
| `void` | boolean | When `true`, the server declined to estimate (query is out of domain). `distribution` is `null`. |
| `distribution.p10`/`p50`/`p90` | integer | Combined input + output tokens at the 10th, 50th, 90th percentiles of the predicted distribution. |
| `distribution.unit` | string | Always `"tokens"` in v1. |
| `band` | object \| null | Additive. A coarse, log-scale spend range derived by coarsening `distribution.p10–p90` onto fixed bins — a clearer "cheap or expensive?" read of the **same** estimate, not a separate or more accurate one. `null` when `void = true` (mirrors `distribution`). |
| `band.low` | integer | Token floor of the band. `0` for the open bottom bin (`"<100k"`). |
| `band.high` | integer \| null | Token ceiling of the band. `null` for the open top bin (`"1B+"`). |
| `band.label` | string | Human, **display-only** label (e.g. `"1M–3M"`, `"<100k"`, `"1B+"`). **Do not parse it** — use `low`/`high` as the machine-readable bounds. |
| `band.unit` | string | Always `"tokens"` in v1. |
| `confidence` | number | `[0, 1]`. Single user-facing summary of estimate quality. Renderable as a bar, badge, etc. |
| `model` | string | Echo of the resolved model (the input value, or the server default if input was omitted). |
| `expires_at` | string | RFC 3339. Estimates older than this should be considered stale (the underlying model may have retrained). |

**Band bins (v1).** The band coarsens the `p10–p90` interval onto a fixed half-decade (×~3) log scale with edges at `100k, 300k, 1M, 3M, 10M, 30M, 100M, 300M, 1B` (bins `(0,100k]`, `(100k,300k]`, …, `(300M,1B]`, `(1B,∞)`). `band.low` is the lower edge of the bin containing `p10`; `band.high` is the upper edge of the bin containing `p90` (`null` above `1B`). The band's **width is emergent** — it tightens automatically as the underlying interval tightens, because it is a faithful re-expression of `p10–p90`, **not** a separate or more accurate estimate. The bin scheme is a v1 default and **may change** (like the numeric percentiles in §9, it is not guaranteed reproducible bit-for-bit); always read `low`/`high`, never the label.

**Void response — 200 OK**

```json
{
  "estimate_id": "est_01HYYYYYYYYYYYYYYYYYYYYYY",
  "scenario": "out_of_domain",
  "void": true,
  "distribution": null,
  "band": null,
  "confidence": 0.0,
  "model": "claude-opus-4-7",
  "expires_at": "2026-05-27T10:14:00Z"
}
```

A void response is **not an error**. Clients should render it as "Budgetary cannot confidently estimate this query" — this is itself a useful product signal (it tells the user to gate or budget the run manually).

### 4.2 `POST /v1/actuals`

Submits the realized token spend for a previously estimated query. This is the telemetry endpoint that feeds the predicted-vs-actual ledger.

**Request**

```json
{
  "estimate_id": "est_01HXXXXXXXXXXXXXXXXXXXXXXX",
  "tokens_in": 12340,
  "tokens_out": 36210,
  "success": true,
  "duration_ms": 420000,
  "metadata": {
    "error": null,
    "tool_calls": 47
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `estimate_id` | string | yes | Must match an `estimate_id` previously returned by `/v1/estimate` for the same org. |
| `tokens_in` | integer | yes | Total input tokens consumed across all model calls in the run. |
| `tokens_out` | integer | yes | Total output tokens generated across all model calls in the run. |
| `success` | boolean | yes | Whether the agent run completed its objective. Used to separate "failed and burned tokens" from "succeeded and burned tokens" in calibration. |
| `duration_ms` | integer | yes | Wall-clock duration of the run in milliseconds. |
| `metadata` | object | no | Free-form, max 2 KB serialized. Fields are **not** analyzed, with one **reserved** exception: `metadata.source` (see below). |
| `trace` | array | no | Best-effort execution trace (0019) — an array of per-step records used to decompose the run into behavior phases on `GET /v1/ledger`. See below. |
| `produced_changes` | integer | no | Best-effort acceptance signal (0023b) — count of **discrete** file-mutating operations the agent produced this task (Edit/Write-class events, **not lines**). Measured client-side, never model-supplied. See below. |
| `accepted_changes` | integer | no | Of `produced_changes`, how many **survived** to session close (`≤ produced_changes`). Measured client-side. See below. |
| `external_symbols` | integer | no | Best-effort symbol-resolution signal (0023d) — count of **distinct external API symbols** the produced code referenced (the resolvable surface). Measured client-side, never model-supplied. See below. |
| `unresolved_symbols` | integer | no | Of `external_symbols`, how many did **not resolve** against the installed environment (`≤ external_symbols`) — structural hallucinations. Measured client-side. See below. |

**Acceptance signal (0023b).** `produced_changes` / `accepted_changes` are two **discrete change counts** (never lines, never file paths/diffs/content — only integers) that let the server report on `GET /v1/ledger` whether spend **converted into output that stuck**. They are **best-effort and fail-closed**, exactly like `trace`: a bad or partial pair (negative, non-integer, `accepted > produced`, or only one of the two) is **dropped wholesale** — both stored `NULL`, the call still returns `202`, no `422` (the total is the contract, the counts are a bonus). They are **measured client-side, never model-supplied** (there is no model-writable acceptance surface), and **omitted** on hosts that don't expose per-edit events (never fabricated). They surface only as the derived `conversion` block on the ledger, never echoed back.

**Symbol-resolution signal (0023d).** `external_symbols` / `unresolved_symbols` are two **discrete symbol counts** (never symbol names, never code, never file paths — only integers) that let the server report on `GET /v1/ledger` a coverage-gated **structural-hallucination rate** — for tasks like yours, how often does code run but reference a symbol that **does not exist**. `external_symbols` is the resolvable surface (distinct external references); `unresolved_symbols` is how many of those did not resolve against the installed environment. They are **best-effort and fail-closed**, exactly like the acceptance counts: a bad or partial pair (negative, non-integer, `unresolved > external`, or only one of the two) is **dropped wholesale** — both stored `NULL`, the call still returns `202`, no `422`. They are **measured client-side by a linter-grade resolver, never model-supplied**, and **omitted** on hosts / ecosystems where resolution is not observable (never fabricated). This measures structural **existence only** — not whether a real symbol was used correctly. They surface only as the derived `resolution` block on the ledger, never echoed back.

**Reserved: `metadata.source` (0024).** The one key inside `metadata` the server ever reads. It is an **opaque provenance label** naming the client or harness that produced the run (the shipped `@budgetary/mcp` sends the constant `mcp_client`).

**For your org it is stored and ignored. It confers nothing.** Setting it — to any value, including one you may see elsewhere — changes nothing about what is recorded, how your data is used, or how your estimates are answered. There is no value you can put here that grants your rows any standing they would not otherwise have.

It is read **only** for orgs the operator has explicitly designated, where it distinguishes one internal harness from another. The reason it cannot be read for anyone else is that it is **client-supplied**, and a client-supplied provenance claim is not evidence of provenance. How a row is treated is derived **server-side, from the authenticated org** — never from anything the request says about itself. This is stated plainly so that the field's limits are as public as the field is.

**Trace (0019).** Each element is `{ "tool": string (≤64 chars), "tokens": integer ≥ 0, "kind"?: string, "target"?: string, "ok"?: boolean }`:

- `tokens` is that step's realized cost on the **same basis as the total** — `(tokens_in − cache_read) + tokens_out`, with `cache_read` **excluded**. The trace is **real measured usage**, never model-supplied.
- `kind` is an optional advisory **family hint** (e.g. `"read"`, `"edit"`, `"test"`); `target` / `ok` are optional best-effort **observations** (what the step acted on; whether it succeeded). The **server**, not the client, decides every behavior phase — these fields are inputs to that decision, never phase labels, and a client can never label a step a retry.
- The trace is **best-effort and capped at ≤512 steps / ≤16 KB serialized**. A missing, malformed, or oversized trace is **dropped** — the call still returns `202` and the total is still recorded (**a bad trace never fails the actuals call**; the total is the contract, the trace is a bonus). `trace` is never echoed back; it surfaces only as the derived `phases` on the ledger.

**Response — 202 Accepted**

```json
{
  "received": true,
  "ledger_entry_id": "led_01HZZZZZZZZZZZZZZZZZZZZZ"
}
```

Idempotent: re-submitting the same `estimate_id` returns 202 with the original `ledger_entry_id`; the second body is ignored. This lets clients retry safely without producing duplicate entries.

If the `estimate_id` is unknown or belongs to a different org, returns `404 not_found`.

### 4.3 `GET /v1/ledger`

Paginated history of estimates joined with actuals. Powers the VS Code dashboard.

**Query parameters**

| Param | Type | Notes |
|---|---|---|
| `project_id` | string | Filter to a single project. |
| `host` | string | Filter to a single client host. |
| `after` | string | Cursor for forward pagination; pass the previous response's `next_cursor`. |
| `limit` | integer | Default 50, max 200. |
| `include_orphans` | boolean | Default `false`. When `true`, include estimates that have no matching actuals yet. |
| `since` | string | RFC 3339 timestamp lower bound on `created_at`. |

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
      },
      "phases": {
        "exploration": { "tokens": 14000, "share": 0.288 },
        "generation":  { "tokens": 22000, "share": 0.453 },
        "testing":     { "tokens": 9550,  "share": 0.197 },
        "retries":     { "tokens": 3000,  "share": 0.062 },
        "other":       { "tokens": 0,     "share": 0.0 },
        "total_tokens": 48550,
        "scheme_version": "phases-v4"
      },
      "assessment": {
        "verdict": "normal",
        "note": null,
        "efficiency": { "burn_share": 0.062, "label": "lean" },
        "conversion": {
          "produced_changes": 8,
          "accepted_changes": 7,
          "cost_per_accepted": 6935.7,
          "percentile_vs_peers": 0.42,
          "verdict": "normal"
        },
        "resolution": {
          "external_symbols": 24,
          "unresolved_symbols": 0,
          "unresolved_rate": 0.0,
          "region_rate": 0.021,
          "verdict": "low"
        },
        "scheme_version": "assessment-v4"
      }
    }
  ],
  "next_cursor": "est_01HXY..."
}
```

`actual` is `null` if no `/v1/actuals` has been submitted yet (only returned when `include_orphans=true`).

`next_cursor` is `null` when no further pages exist.

`query_excerpt` is the first 120 characters of the original query, with longer queries elided. Full query text is **not** returned via the ledger — clients that need full text should persist it locally at estimate time.

Query text is stored **encrypted at rest** (AES-256-GCM, server-held key — Tier-5), and `query_excerpt` is decrypted on read for the **owning org only**: the ledger is org-scoped and authenticated, so it returns you your own text and never another org's. This is a storage change, not a contract change — the field's shape, semantics and 120-character limit are unchanged. It is `""` when the org has opted out of query-text retention (0011-3), exactly as before.

Note the ceiling, stated plainly: encryption at rest with a server-held key is **not** end-to-end encryption, and the stored embedding is not encrypted (kNN retrieves on it).

**`phases` (0019, additive).** A breakdown of the realized spend into plain-language behavior phases — `exploration`, `generation`, `testing`, `retries`, `other` — each `{ tokens, share }`. This is **measurement, not prediction**: the per-phase `tokens` are **exact** over the tokens the forwarded `trace` reports, and the five `share` values sum to `1.0` (within floating-point tolerance) when `total_tokens > 0`. `phases` is `null` when no trace was forwarded with the actuals (the breakdown is a bonus, not a guarantee). `scheme_version` identifies the classifier version; the scheme is a default and **may change** (do not assume bit-for-bit reproducibility).

When a step's optional `target` is supplied for a generic-shell tool (e.g. `Bash`/`sh`), the server classifies it by **what actually ran** — reading the redacted `target`'s program **or its wrapper subcommand / `python -m` runner** (`pytest …`, `go test …`, `npm test …`, `python pytest …`, `mvn test …`, `gradle build …`, `ruff …` → `testing`; unrecognized or opaque commands like `git …` / `npm run <script>` → `other`) — so verification and `retries` stop hiding in `other`. This is still **best-effort and conservative**: the server never fabricates a phase from a tool name alone, and absent `target` the breakdown is unchanged from the name-only behavior. `scheme_version` advances to `phases-v4` for this command-aware classification (it also recognizes package-runner-invoked tools, e.g. `npx playwright …`, `npx cypress …`).

**`assessment` (0019, additive).** A coverage-gated, plain-language read of "are you fine?" — the actual placed against the task's **own** predicted interval. `verdict` is the machine-readable field, one of:

| `verdict` | Meaning |
|---|---|
| `normal` | Actual fell inside the predicted `[p10, p90]` interval. |
| `efficient` | Actual came in **below** `p10` (cheaper than predicted). |
| `elevated` | Actual ran somewhat **above** `p90`. |
| `anomalous` | Actual ran **far above** `p90`. |
| `insufficient_data` | The estimate had no firm basis to judge against (e.g. `void`, or out-of-distribution). **This is the honest, expected default for most real tasks today** — it is the *question* "are you fine?" answered honestly, not a failure. |

`assessment` is present for **every** entry that has an actual (it does not require a trace); it is `null` only on an orphan estimate (no actual). `note` is an **optional** plain sentence-fragment (e.g. `"retry-heavy"`) attached to an abnormal verdict — **do not parse it**; read `verdict`. `scheme_version` identifies the assessment version and may change.

**`assessment.efficiency` (0023a, additive).** A descriptive read of **where the spend went** — the *composition* of the realized tokens, sitting beside the `verdict` (which judges the *total*). It is `{ burn_share, label }`:

- `burn_share` — the fraction of measured spend in **non-productive phases** (`retries` + unclassified `other`), `0.0`–`1.0`.
- `label` — a display bucket over that composition, one of `lean`, `retry_heavy`, `exploration_heavy`, `insufficient_trace`.

It is derived purely from the already-computed `phases` breakdown, so unlike `note` (which fires only on an abnormal verdict) `efficiency` is present on **every traced entry — including `normal`-total tasks that were internally retry-heavy**. That decoupling is the point: a task can land `normal` on total spend yet be mostly thrash. `efficiency` is **`null` when no trace was forwarded** (it can never be inferred without measured steps); a trace too thin to characterize reports `label: "insufficient_trace"` rather than a confident bucket.

**This is composition, not productivity — do not read it as a value or ROI judgment.** `burn_share` says how much of the bill was churn, *never* whether the work was worth it: a `retry_heavy` task may have shipped the right fix, and a `lean` one may have produced nothing useful.

**`assessment.conversion` (0023b, additive).** A coverage-gated **cost-per-accepted-unit** read — did the spend convert into output that *stuck*, benchmarked against tasks like yours. It is present for **every entry with an actual** (`null` only on an orphan), independently gated on acceptance data:

- `produced_changes` / `accepted_changes` — the measured discrete change counts forwarded on `/v1/actuals` (`null` when none were sent).
- `cost_per_accepted` — realized tokens (cache_read-excluded basis) per change that survived; `null` when nothing was accepted (`accepted_changes == 0`).
- `percentile_vs_peers` — this task's rank in the acceptance-carrying neighbor distribution (`0.0` = cheapest per accepted change … `1.0` = most expensive); `null` when too few comparable neighbors carry acceptance data. The neighbor distribution itself is **never returned**.
- `verdict` — the machine-readable field, one of:

| `verdict` | Meaning |
|---|---|
| `lean` | Cost-per-accepted is **low** vs comparable tasks (bottom of the peer distribution). |
| `normal` | Cost-per-accepted sits in the broad **middle** of comparable tasks. |
| `wasteful` | Cost-per-accepted is in the **top decile** vs peers, **or** changes were produced and **none** survived (`accepted_changes == 0`). |
| `insufficient_data` | No acceptance signal on this actual, **or** too few comparable neighbors carry acceptance data. **This is the honest, expected default for most tasks today** — the benchmark needs comparable data that only accrues with real usage. |

**Do not parse the components as a score** — read `verdict` (never a single collapsed number). **This is efficiency, not productivity** — cost-per-accepted measures conversion of spend into *surviving* output, not whether that output was worth it. Reverts are noisy and lagging (rebases and scope cuts revert good code too); v1 measures **session-close survival** only — cross-day durability is a named later refinement.

**`assessment.resolution` (0023d, additive).** A coverage-gated **structural-hallucination rate** — the first *correctness* read (0023a/0023b measured spend and its conversion). It answers, for tasks like yours: how often does code **run but reference a symbol that does not exist** (a fabricated API, a method that isn't on the real object, a function invented wholesale). Present for **every entry with an actual** (`null` only on an orphan), independently gated on symbol data:

- `external_symbols` / `unresolved_symbols` — the measured discrete symbol counts forwarded on `/v1/actuals` (`null` when none were sent).
- `unresolved_rate` — **this task's** own `unresolved / external`; `null` when `external_symbols == 0` (no external surface to hallucinate on — an honest void, **not** zero-risk). A noisy per-task number, not a verdict on that output.
- `region_rate` — the coverage-gated **silent** structural-hallucination rate for this task's neighbor region: the pooled rate at which the external symbols referenced by comparable tasks fail to resolve — the mean across neighbors of each task's `unresolved / external` (a **symbol-level** rate, **not** the fraction of tasks that hallucinated, which would be higher); `null` when too few comparable neighbors carry symbol data. The neighbor rate distribution itself is **never returned**.
- `verdict` — the machine-readable field, one of:

| `verdict` | Meaning |
|---|---|
| `low` | The region's structural-hallucination rate is **low** (at or below the documented threshold) — for comparable tasks, code rarely references something nonexistent. |
| `elevated` | The region's structural-hallucination rate is **above** the threshold — comparable tasks reference nonexistent symbols more often than we'd like. |
| `insufficient_data` | No symbol signal on this actual, **or** too few comparable neighbors carry symbol data. **This is the honest, expected default for most tasks today** — the benchmark needs comparable data that only accrues with real usage. |

**Do not parse the components as a score** — read `verdict` (never a single collapsed number). This is **structural, not semantic**: it catches symbols that **don't exist**, *not* a real API used with the wrong behavior, and *not* any logic error — so `low` means *low structural-hallucination rate*, **never** "correct." It is **regional, not a per-output flag** — never read `resolution` as "this diff hallucinated → review it" (a per-task count is noisy; the regional aggregate is the signal). The served `region_rate` is the **silent** slice: conditioned on runs that did not fail loudly, because the loud unresolved symbols are already the toolchain's job.

### 4.4 `GET /v1/health`

Unauthenticated liveness probe.

**Response — 200 OK**

```json
{ "status": "ok", "version": "v1" }
```

### 4.5 Billing (additive)

> **Additive (per §3).** These endpoints were added after the initial v1 draft and are not part of the frozen estimate/actuals/ledger surface. Clients that don't use billing can ignore them. Recording subscription state here does **not** by itself gate `/v1/estimate`.

Self-serve subscription management backed by Stripe. Checkout and the billing portal are **Stripe-hosted** — no card data ever touches the Budgetary API; these endpoints return a Stripe URL for the client to redirect the user to.

#### `POST /v1/billing/checkout`

Starts a Stripe Checkout session for a subscription. Requires a bearer API key.

**Request** (all fields optional; URLs fall back to server config)

```json
{
  "success_url": "https://app.example.com/billing/success",
  "cancel_url": "https://app.example.com/billing/cancel"
}
```

**Response — 200 OK**

```json
{ "url": "https://checkout.stripe.com/c/pay/cs_test_..." }
```

| Behavior | Notes |
|---|---|
| `success_url` / `cancel_url` | Must be `https` URLs. Omitted values fall back to the server's `BILLING_SUCCESS_URL` / `BILLING_CANCEL_URL`. A missing or non-`https` URL returns `400 invalid_request`. |
| Billing not configured | Returns `503 unavailable` (never a 500). |

#### `POST /v1/billing/portal`

Opens the Stripe billing portal for the caller's org so they can manage or cancel their subscription. Requires a bearer API key.

**Request** (optional)

```json
{ "return_url": "https://app.example.com/billing" }
```

**Response — 200 OK**

```json
{ "url": "https://billing.stripe.com/p/session/..." }
```

| Behavior | Notes |
|---|---|
| No customer yet | The org must have completed checkout at least once. If it has no Stripe customer, returns `404 not_found`. |
| `return_url` | Falls back to `BILLING_SUCCESS_URL`. Must be `https`. |
| Billing not configured | Returns `503 unavailable`. |

#### `POST /v1/webhooks/stripe`

Stripe → Budgetary subscription-state sync. **Not authenticated with a bearer API key** — the Stripe webhook *signature* is the authentication (verified against `STRIPE_WEBHOOK_SECRET`). This endpoint is for Stripe only; clients never call it.

- A missing, malformed, or invalid `Stripe-Signature` returns `400 invalid_request`.
- If billing is not configured on the server (`STRIPE_WEBHOOK_SECRET` unset), returns `503 unavailable` (Stripe will retry).
- **Idempotent:** redelivered events (same Stripe `event.id`) are acknowledged `200` without reprocessing.
- **Response — 200 OK:** `{ "received": true }`

### 4.6 `GET /v1/meta` (additive)

> **Additive (per §3).** Added after the initial v1 draft; not part of the frozen estimate/actuals/ledger surface. Clients that don't use it can ignore it.

Unauthenticated service-mode signal. Lets clients render the service model (shareware: free, unlimited) and surface policy links — and, once configured, a donate link — without scraping copy. Carries no algorithm internals.

**Response — 200 OK**

```json
{
  "mode": "shareware",
  "price": "free",
  "license_url": "https://budgetary.tools/license",
  "terms_url": "https://budgetary.tools/terms",
  "donate_url": null
}
```

| Field | Type | Notes |
|---|---|---|
| `mode` | string | Service model. Currently always `"shareware"`. |
| `price` | string | Currently always `"free"`. |
| `license_url` | string \| null | URL of the service license/terms-of-use, or `null` if not configured. |
| `terms_url` | string \| null | URL of the terms of service, or `null` if not configured. |
| `donate_url` | string \| null | Optional voluntary-donation link (third-party, link-out only). `null` unless configured; `null` is the expected default. |

All fields except `mode`/`price` are server-config-driven and may be `null`. Clients must treat a `null` `donate_url` as "no donate affordance". See [shareware.md](shareware.md) for the model and the donation policy.

## 5. Scenario labels (v1)

Returned in the `scenario` field of `/v1/estimate` responses. Clients should render each meaningfully; unknown future values must be treated as `uncertain`.

| Label | Meaning | Recommended client UI |
|---|---|---|
| `confident` | The estimate is well-supported. The distribution is reliable. | Show p50 prominently; show p10–p90 range. |
| `uncertain` | The estimate is supported but the distribution is wide. | Show p50 with the full range and an "uncertain" badge. |
| `sparse_evidence` | The query is near the edge of what's been seen before. | Show the distribution but warn the user that calibration is weak. |
| `out_of_domain` | The query is too far from anything seen. Returned with `void=true`. | Tell the user we can't estimate this and let them proceed at their own risk. |

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
| 403 | `permission_denied` | Key is valid but lacks scope for this endpoint or resource. |
| 404 | `not_found` | The referenced resource (e.g., `estimate_id`) does not exist or is not visible to this key. |
| 413 | `payload_too_large` | `query` or `metadata` exceeds the documented size limit. |
| 429 | `rate_limited` | Tier rate limit exceeded. See §7. |
| 500 | `internal_error` | Server-side failure; include `request_id` in support inquiries. |
| 503 | `unavailable` | Server is in maintenance or degraded mode; retry with backoff. |

`request_id` is always present and uniquely identifies the request in server logs.

## 7. Rate limits and quotas

When a request is rejected for exceeding a limit, the `429` response carries:

```
Retry-After:           <seconds>
```

`Retry-After` is the **only** rate-limit header the server sets, and it appears on the `429` only. (Per-window `X-RateLimit-Limit`/`Remaining`/`Reset` headers are **not** emitted — emitting them is a possible future enhancement.)

The limits below are **enforced only when the limiter is enabled** (it is off by default in the current deployment); when disabled, no `429` is returned and no `Retry-After` is set. Default per-key limits (subject to change per pricing tier — confirm in your account settings):

| Tier | `/v1/estimate` | `/v1/actuals` | `/v1/ledger` |
|---|---|---|---|
| Free | 100 / day | 1 000 / day | 60 / minute |
| Paid | configured per contract | configured per contract | 600 / minute |

`/v1/actuals` is intentionally rate-limited far more loosely than `/v1/estimate`, because dropped telemetry hurts both the customer and the model.

## 8. Idempotency and retries

- `POST /v1/estimate`: **not idempotent today.** `client_request_id` is accepted (up to 128 chars) but currently ignored — each call, including a retry carrying the same `client_request_id`, produces a new `estimate_id`, recomputes, and is billed separately. Do **not** rely on it for dedup. (True idempotent replay — same key within a window → the original response, no recompute, no rebill — is a named future feature; it is not implemented, so no `409 idempotency_conflict` is ever returned.)
- `POST /v1/actuals`: idempotent on `estimate_id`. Safe to retry on network failure.
- `GET /v1/ledger`: idempotent by HTTP semantics. Use the `after` cursor for stable pagination.
- All endpoints: clients should retry `5xx` and `429` responses with exponential backoff (initial 1 s, factor 2, jitter, max 60 s, give up after 5 attempts).

## 9. Stability guarantees

- Field names, value types, and HTTP status codes in this document are stable for the life of `/v1/`.
- Numerical values (`distribution.p10`, etc.) are server-computed and may shift as the underlying model improves. They are not guaranteed to be reproducible bit-for-bit across requests.
- `estimate_id` and `ledger_entry_id` are opaque tokens; do not parse them.
- ULID format is an implementation detail and may change; treat IDs as strings.

## 10. Changelog

| Date | Change |
|---|---|
| 2026-05-27 | Initial draft of v1. |
| 2026-06-05 | Added billing endpoints (`POST /v1/billing/checkout`, `POST /v1/billing/portal`, `POST /v1/webhooks/stripe`) — additive per §3. |
| 2026-06-08 | Added `GET /v1/meta` (unauthenticated shareware service-mode signal) — additive per §3; no existing endpoint changed. |
| 2026-06-10 | Added `band` (additive log-scale categorical spend range) to `POST /v1/estimate`, derived by coarsening `distribution.p10–p90`; `null` when void. A presentation re-expression of the same estimate, not an accuracy change — no existing field touched, additive per §3. |
| 2026-06-12 | Added an optional `trace` to `POST /v1/actuals` (best-effort, fail-closed, ≤512 steps / ≤16 KB — a bad trace never fails the call), and additive `phases` (exact behavior breakdown where a trace exists) + `assessment` (coverage-gated "are you fine?" verdict; mostly `insufficient_data` today) to `GET /v1/ledger` entries. No new endpoint, no estimate math change — additive per §3. |
| 2026-06-12 | `phases` classifier is now **command-aware** for generic-shell steps: when a `Bash`/`sh`/… step forwards a `target`, the server classifies by the leading program token (`pytest`/`go test`/`npm test`/`ruff` → `testing`; unrecognized → `other`), so `testing` and `retries` stop hiding in `other`. No field added or changed; absent `target` the breakdown matches prior behavior. `scheme_version` → `phases-v2`. |
| 2026-06-12 | `phases` command-aware classification generalized to **wrapper runners** — the redacted `target`'s second token (a leak-safe subcommand or `python -m` runner) is now classified too, so `python -m pytest`, `mvn test`, `gradle build`, `rake test`, `cargo check`, etc. land in `testing` instead of `other` (previously only `go`/`cargo`/`npm`/`pnpm`/`yarn`/`dotnet` were covered). No field added or changed. `scheme_version` → `phases-v3`. |
| 2026-06-14 | `phases` now classifies the package-runner test/quality tools the client forwards via `npx`/`pnpm dlx`/`yarn dlx`/`bunx` — added `playwright`, `cypress`, `ava`, `tap`, `jasmine`, `karma`, `nyc`, `c8`, `biome` to the testing allowlist, so `npx playwright test`, `npx cypress run`, etc. land in `testing`. No field added or changed. `scheme_version` → `phases-v4`. |
| 2026-06-24 | Added an additive `assessment.efficiency` (`{ burn_share, label }`) to `GET /v1/ledger` entries — the *composition* of the realized spend (how much was churn: `retries` + unclassified `other`), derived from the existing `phases`. Present on **every traced entry** including `normal`-total ones (decoupled from `verdict`); `null` without a trace, `insufficient_trace` on a too-thin one. **Composition, not productivity** — not a value/ROI judgment. No new ingested signal, no migration, no estimate math change — additive per §3. `assessment.scheme_version` → `assessment-v2`. |
| 2026-07-02 | Added optional `produced_changes` / `accepted_changes` (discrete change counts, **not lines**; measured client-side, fail-closed, `accepted ≤ produced` — a bad pair is dropped, never a `422`) to `POST /v1/actuals`, and an additive `assessment.conversion` block (coverage-gated **cost-per-accepted-unit** vs comparable tasks — `verdict ∈ {lean, normal, wasteful, insufficient_data}`, mostly `insufficient_data` today) to `GET /v1/ledger` entries. The peer distribution behind the percentile is **never returned**. **Efficiency, not productivity.** New nullable columns + one migration; no estimate math change — additive per §3. `assessment.scheme_version` → `assessment-v3`. |
| 2026-07-03 | Added optional `external_symbols` / `unresolved_symbols` (discrete symbol counts, **not code/names**; measured client-side, fail-closed, `unresolved ≤ external` — a bad pair is dropped, never a `422`) to `POST /v1/actuals`, and an additive `assessment.resolution` block (coverage-gated **structural-hallucination rate** vs comparable tasks — the first *correctness* axis; `verdict ∈ {low, elevated, insufficient_data}`, mostly `insufficient_data` today) to `GET /v1/ledger` entries. The neighbor rate distribution behind `region_rate` is **never returned**. **Structural existence only, not semantic correctness** (`low` ≠ correct); **regional, not a per-output flag**. New nullable columns + one migration; no estimate math change — additive per §3. `assessment.scheme_version` → `assessment-v4`. |
| 2026-07-14 | **Correction, not a change.** `metadata` was documented as *"Fields are **not** analyzed"* — which stopped being true when 0024a shipped: the server reads **`metadata.source`** as an opaque provenance label, but **only for operator-designated orgs**. For every other org it is stored and ignored, and confers nothing (the promotion lane is derived **server-side from the authenticated org**, never from a client-supplied claim). The published client `@budgetary/mcp` ≥ 0.6.0 now sends the constant `mcp_client`, so the field is visible in the wild and its limits must be public too. **No behavior change, no new field, no migration** — the contract now describes what the server has been doing since 0024a. |
