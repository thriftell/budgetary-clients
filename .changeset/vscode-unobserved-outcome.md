---
"budgetary-vscode": patch
---

Dashboard: render an unobserved run outcome as *not reported*, never as a
failure.

`actual.success` on `GET /v1/ledger` is now three-valued — `true`, `false`, and
`null`, where **`null` means nobody observed the outcome**. The results table
picked the glyph with a truthy check, so every such row displayed **✗
failed**: a reported failure on the strength of a measurement that was never
taken, which is the worse of the two possible misreadings.

- The three states now render distinctly: **✓** succeeded, **✗** failed, **—**
  *not reported*, each with its own accessible label so a screen reader
  announces which one it is.
- Compared against the literals rather than for truthiness, so a value this
  version does not recognize also lands on the em-dash instead of silently
  joining one of the two verdicts.
- Distinct from the existing **○ pending**: that row is still waiting for its
  actual, while this row *has* its actual — the realized spend is measured and
  shown — and simply carries no verdict.
