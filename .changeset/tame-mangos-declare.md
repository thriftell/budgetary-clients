---
"@budgetary/sdk": patch
---

Declare the measured `phases` and `assessment` fields that already arrive on
`POST /v1/actuals` and `GET /v1/ledger`.

Types only — no runtime change. The transport's deep-camelCase walk has no
allowlist, so both blocks have always reached callers intact; only the type
declarations omitted them, forcing consumers to cast. `LedgerEntry` and
`ActualsResponse` now carry optional, nullable `phases` / `assessment`, with
`Phases`, `Assessment`, `Efficiency`, `LedgerAssessment`, `LedgerConversion`,
`LedgerResolution` and the `AssessmentVerdict` / `EfficiencyLabel` /
`ConversionVerdict` / `ResolutionVerdict` label unions exported.

Additive and backward-compatible: every new field is optional, so existing code
keeps compiling. `undefined` means the server did not send the field, `null`
means it sent one with nothing to give — render either as silence, never as a
computed value.
