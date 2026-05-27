# budgetary

Python SDK for the [Budgetary](https://api.budgetary.tools) API — a hosted service that returns probabilistic pre-inference estimates of token spend for LLM queries. The SDK is a thin, typed HTTP wrapper around the v1 contract documented at [docs/api-contract.md](../../docs/api-contract.md).

## Install

While the SDK is in 0.x it is not yet published to PyPI. Install directly from the repository:

```bash
pip install "git+https://github.com/rickyjs1955/budgetary-clients.git#subdirectory=sdk/python"
```

Once 1.0 ships, `pip install budgetary` will be the canonical install.

## Quickstart

```python
import os
from budgetary import BudgetaryClient

client = BudgetaryClient(api_key=os.environ["BUDGETARY_API_KEY"])

estimate = client.estimate(
    "fix the flaky test in the payments service",
    model="claude-opus-4-7",
    context={"host": "sdk", "project_id": "proj_kx7"},
)

print(estimate.scenario, estimate.distribution)
```

`BudgetaryClient` is a context manager; using `with` (or calling `close()`) releases the underlying `httpx.Client`:

```python
with BudgetaryClient(api_key=...) as client:
    page = client.get_ledger(project_id="proj_kx7", limit=50)
```

## Error handling

Every documented HTTP status maps to a typed exception. Retryable errors (`429`, `5xx`) are retried automatically with exponential backoff and jitter — by the time an exception reaches your code, retries have already been exhausted.

```python
from budgetary import (
    BudgetaryRateLimitError,
    BudgetaryValidationError,
)

try:
    client.estimate(query)
except BudgetaryRateLimitError as err:
    # retry_after_seconds may be None if the server didn't send Retry-After
    print(f"rate limited; retry after {err.retry_after_seconds}s")
except BudgetaryValidationError as err:
    print(f"bad input: {err.message}")
```

The full hierarchy:

| Exception | When |
|---|---|
| `BudgetaryError` | Base class. Exposes `code`, `http_status`, `request_id`. |
| `BudgetaryAuthError` | `401`, `403`. |
| `BudgetaryNotFoundError` | `404`. |
| `BudgetaryValidationError` | `400`, `409`, `413`. |
| `BudgetaryRateLimitError` | `429`. Also exposes `retry_after_seconds`. |
| `BudgetaryServerError` | `5xx`. |
| `BudgetaryNetworkError` | Transport-level failure (timeout, connection error). |

## Constructor options

| Option | Type | Default | Notes |
|---|---|---|---|
| `api_key` | `str` | _required_ | Sent as `Authorization: Bearer <api_key>`. |
| `base_url` | `str` | `"https://api.budgetary.tools"` | Override for staging or self-hosted endpoints. |
| `timeout_ms` | `int` | `10_000` | Per-request timeout. |
| `max_retries` | `int` | `5` | Max retries on `429` and `5xx`. Total attempts = `max_retries + 1`. |
| `http_client` | `httpx.Client \| None` | a new one | Inject your own `httpx.Client` (mainly for tests or connection pooling). |

## Idempotency

`estimate()` accepts an optional `client_request_id` forwarded to the server as `client_request_id`. The API treats identical replays within 24 hours as the same call, returning the original response without rebilling. The SDK auto-generates a fresh UUID v4 on every call by default so retries are safe out of the box.

```python
# default — SDK generates a UUID
client.estimate("...")

# caller-supplied
client.estimate("...", client_request_id="my-deterministic-id")

# explicit opt-out — no client_request_id sent
client.estimate("...", client_request_id=None)
```

## Sync only

This release ships sync APIs only. Callers in async code can wrap each call:

```python
import asyncio

async def estimate_async(client, query):
    return await asyncio.to_thread(client.estimate, query)
```

A first-class async client (`AsyncBudgetaryClient` backed by `httpx.AsyncClient`) is planned for a later release.

## Reference

For the full v1 API contract — endpoints, error codes, scenario labels, idempotency semantics — see [docs/api-contract.md](../../docs/api-contract.md).

Licensed under [Apache-2.0](../../LICENSE).
