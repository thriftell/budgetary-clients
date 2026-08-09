---
"@budgetary/sdk": minor
---

`ActualsRequest` gains the optional `censoring` field the API contract has
specified all along.

`POST /v1/actuals` accepts an optional run-termination category — `censoring`,
one of exactly `natural` | `harness_watchdog` | `operative_cap` | `kill_switch`
— and the published contract in this repo specifies it in full. The SDK's
request type declared no such key and no index signature, so there was no
structural route for a caller to send it: the contract was true and the client
was missing.

- `ActualsRequest.censoring` is typed as the closed four-member union, exported
  as `CensoringCategory`, with the vocabulary itself exported as
  `CENSORING_CATEGORIES` so callers validate against one source.
- **Omission is the honest default.** The field is optional and never
  defaulted: an absent field stores *unknown*, which is the truth when nothing
  observed how the run ended. `natural` is an affirmative claim, never a
  fallback — and there is deliberately no `normalizeCensoring()` helper,
  because an unknown category has no safe floor and omission is the only
  honest coercion.
- The wire key is already snake-shaped and values are never transformed, so
  serialization is unchanged; a request without the field is byte-identical to
  one built before this release.
- `cap_ms` / `cap_tokens` (the contract's two cap fields) are deliberately NOT
  added: no channel an agent host controls exposes a per-run cap to a client,
  so a client-built request has no honest source for them.
