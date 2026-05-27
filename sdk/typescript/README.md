# @budgetary/sdk

TypeScript SDK for the [Budgetary](https://api.budgetary.dev) API — a hosted service that returns probabilistic pre-inference estimates of token spend for LLM queries. The SDK is a thin, typed HTTP wrapper with zero runtime dependencies; it speaks the v1 contract documented at [docs/api-contract.md](../../docs/api-contract.md).

## Install

While the SDK is in 0.x it is not yet published to npm. Install directly from the repository:

```bash
pnpm add github:budgetary/budgetary-clients#main --filter @budgetary/sdk
```

Once 1.0 ships, `pnpm add @budgetary/sdk` will be the canonical install.

## Quickstart

```ts
import { BudgetaryClient } from "@budgetary/sdk";

const client = new BudgetaryClient({ apiKey: process.env.BUDGETARY_API_KEY! });

const estimate = await client.estimate("fix the flaky test in the payments service", {
  model: "claude-opus-4-7",
  context: { host: "sdk", projectId: "proj_kx7" },
});

console.log(estimate.scenario, estimate.distribution);
```

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
- `BudgetaryAuthError` — `401`, `403`.
- `BudgetaryNotFoundError` — `404`.
- `BudgetaryValidationError` — `400`, `409`, `413`.
- `BudgetaryRateLimitError` — `429`; exposes `retryAfterSeconds`.
- `BudgetaryServerError` — `5xx`.
- `BudgetaryNetworkError` — no response received (`timeout`, `network`, `abort`).

## Constructor options

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | _required_ | Sent as `Authorization: Bearer <apiKey>`. |
| `baseUrl` | `string` | `https://api.budgetary.dev` | Override for staging or self-hosted endpoints. |
| `timeoutMs` | `number` | `10_000` | Per-request timeout via `AbortSignal.timeout`. |
| `maxRetries` | `number` | `5` | Maximum retries on `429` and `5xx`. Total attempts = `maxRetries + 1`. |
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
