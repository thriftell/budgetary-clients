---
"@budgetary/sdk": patch
---

docs: stop advertising idempotent replay that does not exist

The README's `## Idempotency` section promised that "the API treats identical
replays within 24 hours as the same call, returning the original response
without rebilling," and that "retries are safe out of the box." None of that is
true. `POST /v1/estimate` is **not** idempotent: `client_request_id` is accepted
but ignored, and every call — including a retry carrying the same
`client_request_id` — mints a new `estimate_id`, recomputes, and is billed as a
separate estimate. A caller who built a retry loop on the documented guarantee
paid for every retry.

The README now states the correction, in the language of the corrected API
contract (§4.1, §8): `client_request_id` is a correlation id only, and
`POST /v1/actuals` is the endpoint that is genuinely idempotent (on
`estimate_id`).

Docs only — no runtime behavior changes. The version bump exists because npm
renders the README from the published tarball, not from git: without a release,
the false promise stays live on the package page.
