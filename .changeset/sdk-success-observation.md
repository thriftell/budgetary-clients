---
"@budgetary/sdk": minor
---

`success` on `POST /v1/actuals` becomes optional: it is an observation, not a
status.

The contract now specifies `success` as optional, with absent meaning **the
outcome was not observed** — which does not mean the run failed, and does not
mean it succeeded. The SDK's request type declared it required, so "I did not
measure this" was unrepresentable and a caller with no oracle had to manufacture
a verdict. That value is permanent: the endpoint is idempotent per estimate,
only the first stored submission's value is kept, and there is no update call.

- **`ActualsRequest.success` is now `success?: boolean`.** Unset ⇒ the key is
  **absent from the wire body**, never `undefined` and never `null`. Pinned by
  test on the serialized request, including the case where a caller spreads an
  explicitly-`undefined` value in.
- **Nothing changes for a caller that measured the outcome.** An explicit
  `true`/`false` is sent verbatim, in the same key position, so a request that
  declares a verdict is byte-identical to one built before this release.
- **`LedgerActual.success` widens to `boolean | null`** on `GET /v1/ledger`.
  ⚠️ This is the one change a consumer must act on: a truthy check on this
  field renders an unobserved run as a **failure**. Treat it as three-valued.
  It stays required (never absent) so `null` is handled on purpose rather than
  fallen into.
- The Python SDK in this repo moves the same way: `submit_actuals(...,
  success: bool | None = None)`, with the key omitted from the body when
  `None` and the remaining key order unchanged so an explicit verdict still
  serializes byte-for-byte as before.

Omission is the honest default, and it is never defaulted in either direction:
recording an unobserved run as succeeded biases every downstream read toward
success, and recording it as failed does the mirror-image damage. Both are
affirmative false claims. The field is never model-supplied and never inferred
from a transcript — an agent's account of its own run is not a measurement.
