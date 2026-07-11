---
"@budgetary/sdk": patch
"@budgetary/mcp": patch
---

Trust response *bodies* as little as the transport already trusts the network:
close every path where a malformed 2xx becomes a crash or fabricated data.
(Python parity changes ship in the same commit — Python is outside changesets.)

- **Shape-validate the estimate body (fabrication guard).** `client.estimate`
  now validates the parsed 2xx before returning it: a non-empty string
  `estimateId`, a boolean `void`, and finite-number `p10`/`p50`/`p90` when not
  void — otherwise a typed `BudgetaryNetworkError("unusable response body")`. An
  empty body, a wrong-shape 200 (missing `distribution`), or a wrong-*typed* 200
  (string percentiles — `"123"` would render as a real number and be stored as a
  fabricated estimate) is caught here instead of crashing downstream. The MCP
  `estimate` tool additionally wraps its render+store block so a malformed shape
  that reaches it degrades to graceful transport-error text and stores no pending
  entry (the tool's "never throws" contract). Python's `_parse_estimate` gains
  the matching type checks (rejecting `bool` percentiles, which are `int`
  subclasses).
- **Deeply-nested JSON stays inside the taxonomy.** The SDK's own recursive
  walks (`assertFiniteNumbers` / `toCamelCase`) are now iterative (explicit
  worklist), so a deeply-nested 2xx can't blow the call stack with a raw
  `RangeError`; Python adds `RecursionError` to the `json.loads` except clause.
- **`Retry-After: nan` no longer reaches `sleep`.** Python's `_parse_retry_after`
  returns a value only when it is finite, so a `nan`/`inf` header can't pierce the
  min/max clamp into `time.sleep(nan)` (a raw `ValueError`).
- **Transcript totals fail closed on an out-of-range sum.** `readTranscriptUsage`
  now guards the SUMMED totals (not just each field): an overflow to `Infinity`
  or past `Number.MAX_SAFE_INTEGER` — which `JSON.stringify` serializes as `null`
  on the wire — makes the reader submit nothing instead of a corrupt actual.
