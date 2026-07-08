# @budgetary/sdk

TypeScript SDK for the [Budgetary](https://api.budgetary.tools) API — a hosted service that returns probabilistic pre-inference estimates of token spend for LLM queries. The SDK is a thin, typed HTTP wrapper with zero runtime dependencies; it speaks the v1 contract documented at [docs/api-contract.md](../../docs/api-contract.md).

## Install

`@budgetary/sdk` is not published to npm until 1.0. Until then, install it from this repository.

**pnpm** (supported today):

```bash
pnpm add "github:thriftell/budgetary-clients#main&path:sdk/typescript"
```

Keep the quotes so your shell doesn't split on `&`, and use `#main` (not a feature branch).

**npm / yarn:** installing the SDK from a git subdirectory is **not supported**. npm and yarn ignore the `&path:` fragment — they print a warning like `ignoring unknown key "…&path"`, exit 0, and silently install the repository root (a private workspace) instead of `@budgetary/sdk`, leaving the import unresolvable with no error. Until `@budgetary/sdk` is published to npm at 1.0, **npm and yarn users should install with pnpm** (above).

Once 1.0 ships, `npm install @budgetary/sdk` / `pnpm add @budgetary/sdk` / `yarn add @budgetary/sdk` becomes the canonical install for everyone.

## Quickstart

```ts
import { BudgetaryClient, normalizeScenario } from "@budgetary/sdk";

const client = new BudgetaryClient({ apiKey: process.env.BUDGETARY_API_KEY! });

const estimate = await client.estimate("fix the flaky test in the payments service", {
  model: "claude-opus-4-7",
  context: { host: "sdk", projectId: "proj_kx7" },
});

if (estimate.void || estimate.distribution === null) {
  // The server declined to estimate (out of domain). Not an error.
  console.log("No confident estimate for this query.");
} else {
  const { p10, p50, p90 } = estimate.distribution;
  console.log(
    `~${p50} tokens (p10–p90: ${p10}–${p90}), scenario: ${normalizeScenario(estimate.scenario)}`,
  );
}
```

## Reading an estimate

A successful estimate is a **range, not a point**. `distribution` gives `p10`, `p50`, and `p90` combined input+output tokens; treat `p50` as the midpoint of that range, not a guaranteed cost. Three fields tell you how much to trust it:

- **`scenario`** (contract §5) — `confident` (the range is reliable), `uncertain` (supported but wide), `sparse_evidence` (near the edge of what's been seen), or `out_of_domain` (returned with `void: true`). The server may add labels at any time, so fold unknown values with `normalizeScenario(scenario)`, which maps anything unrecognized to `"uncertain"` — never treat an unknown label as confident.
- **`confidence`** — a single `[0, 1]` quality summary. Lower means a wider range and a rougher midpoint. Read it alongside `scenario`, not as a probability.
- **`void`** — `true` when the server declined to estimate (out of domain). Branch on it before reading `distribution`, which is `null` in that case. A void response is not an error.

Don't render a low-confidence or void estimate as if it were a precise number — surface the range and the caveat.

## Closing the loop

After a run, submit the realized counts so future estimates calibrate, then read them back from the ledger. Token counts must be **measured**, never guessed.

```ts
// Submit realized usage for a prior estimate (idempotent on estimateId).
await client.submitActuals({
  estimateId: estimate.estimateId,
  tokensIn: 12_340,
  tokensOut: 36_210,
  success: true,
  durationMs: 420_000,
});

// Read the predicted-vs-actual ledger.
const page = await client.getLedger({ projectId: "proj_kx7", limit: 50 });
for (const entry of page.entries) {
  console.log(entry.queryExcerpt, entry.predicted.p50, entry.actual?.total ?? "pending");
}
```

`submitActuals` returns `202` and is idempotent on `estimateId` (safe to retry on a network failure). `getLedger` is paginated — pass the returned `nextCursor` as `after` for the next page, and set `includeOrphans: true` to include estimates with no actuals yet.

## Error handling

Every documented HTTP status maps to a typed exception. Retryable errors (`429`, `5xx`) are retried automatically with exponential backoff and jitter — by the time an error reaches your code, retries have already been exhausted.

```ts
import {
  BudgetaryClient,
  BudgetaryRateLimitError,
  BudgetaryValidationError,
} from "@budgetary/sdk";

try {
  await client.estimate(query);
} catch (err) {
  if (err instanceof BudgetaryRateLimitError) {
    console.warn(`rate limited; retry after ${err.retryAfterSeconds}s`);
  } else if (err instanceof BudgetaryValidationError) {
    console.error(`bad input: ${err.message}`);
  } else {
    throw err;
  }
}
```

The full hierarchy:

- `BudgetaryError` — base class (`code`, `httpStatus`, `requestId`).
- `BudgetaryAuthError` — `401` (key missing, invalid, or revoked — re-authenticate).
- `BudgetaryPermissionError` — `403` (valid key, but lacks scope or an active plan — distinct from `401`).
- `BudgetaryNotFoundError` — `404`.
- `BudgetaryValidationError` — `400`, `409`, `413`.
- `BudgetaryRateLimitError` — `429`; exposes `retryAfterSeconds`.
- `BudgetaryServerError` — `5xx`.
- `BudgetaryNetworkError` — no response received (`timeout`, `network`, `abort`).

## Constructor options

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | _required_ | Sent as `Authorization: Bearer <apiKey>`. |
| `baseUrl` | `string` | `https://api.budgetary.tools` | Override for staging or self-hosted endpoints. |
| `timeoutMs` | `number` | `10_000` | Per-request timeout via `AbortSignal.timeout`. |
| `maxRetries` | `number` | `4` | Maximum retries on `429` and `5xx`. Total attempts = `maxRetries + 1` (5, per contract §8). |
| `fetchImpl` | `typeof fetch` | global `fetch` | Inject a mock fetch in tests. |

## Idempotency

`estimate()` accepts an optional `clientRequestId` that is forwarded to the server as `client_request_id`. The API treats identical replays within 24 hours as the same call, returning the original response without rebilling. The SDK auto-generates a fresh UUID v4 on every call by default so retries are safe out of the box.

```ts
// default — SDK generates a UUID
await client.estimate("...");

// caller-supplied
await client.estimate("...", { clientRequestId: "my-deterministic-id" });

// explicit opt-out — no client_request_id sent
await client.estimate("...", { clientRequestId: null });
```

## Naming conventions

- **Wire protocol** uses `snake_case` (`estimate_id`, `tokens_in`, `client_request_id`).
- **SDK surface** uses `camelCase` (`estimateId`, `tokensIn`, `clientRequestId`).

The SDK converts at the HTTP boundary in both directions; callers never see `snake_case`.

## Reference

For the full API contract — endpoints, error codes, scenario labels, idempotency semantics — see [docs/api-contract.md](../../docs/api-contract.md).

Licensed under [Apache-2.0](../../LICENSE).
