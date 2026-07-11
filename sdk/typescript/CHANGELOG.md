# @budgetary/sdk

## 0.4.1

### Patch Changes

- 4965932: Trust response _bodies_ as little as the transport already trusts the network:
  close every path where a malformed 2xx becomes a crash or fabricated data.
  (Python parity changes ship in the same commit — Python is outside changesets.)

  - **Shape-validate the estimate body (fabrication guard).** `client.estimate`
    now validates the parsed 2xx before returning it: a non-empty string
    `estimateId`, a boolean `void`, and finite-number `p10`/`p50`/`p90` when not
    void — otherwise a typed `BudgetaryNetworkError("unusable response body")`. An
    empty body, a wrong-shape 200 (missing `distribution`), or a wrong-_typed_ 200
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

## 0.4.0

### Minor Changes

- b647e1c: Harden the SDK HTTP transport so the bearer token can't leak and a hostile endpoint can't exhaust or hang the client.

  - **Enforce HTTPS on `baseUrl`.** The client attaches `Authorization: Bearer <key>` to whatever base URL it is given, so it now refuses a non-`https:` `baseUrl` at construction unless the host is a loopback address (`localhost`/`127.0.0.1`/`::1`) or the new `allowInsecure` option is set. The same check is applied when adopting a `base_url` from `~/.budgetary/config.json`: an insecure host is dropped for the secure default rather than sending the key in cleartext.
  - **No redirects.** The `fetch` call now passes `redirect: "error"`, so a hostile endpoint's `3xx` can no longer re-POST the request body (and the `Authorization` header) to a `Location` host (parity with the Python SDK's httpx `follow_redirects=False` default).
  - **Cap the response body.** The body is read with an 8 MiB ceiling — an oversized `Content-Length` is rejected up-front and a lying/absent one is aborted mid-stream — so a giant body can't exhaust memory.

  **Behavior delta:** a `baseUrl` that is `http://` to a non-loopback host is now refused at construction (previously accepted); pass `allowInsecure: true` to opt back in for a trusted local endpoint. `https://` and localhost URLs are unchanged.

## 0.3.2

### Patch Changes

- 4509caa: Declare `engines: { node: ">=22" }`, which the code already assumes.

## 0.3.1

### Patch Changes

- 80118ca: Changelog backfill for the dim-2 "honest presentation" UX pass. These user-facing changes shipped functionally in `@budgetary/sdk` 0.3.0 / `@budgetary/mcp` 0.2.1 / `budgetary-vscode` 0.1.2 but were released without a changeset, so they never reached the changelog. Recorded here for an honest history — there is no code change beyond this note.

  - **@budgetary/sdk:** `normalizeScenario` is now exported (an unknown scenario label folds to `uncertain`); `scenario` is widened to `Scenario | (string & {})` so an unknown server label is not a type error; the constructor now throws on an empty/whitespace API key instead of failing later with an opaque 401; and `void`, `distribution`, `confidence`, and `expiresAt` gained JSDoc.
  - **@budgetary/mcp:** estimates are presented honestly — a confident estimate leads with the point, while an uncertain / sparse-evidence / unknown one leads with the range and a caution note, and a non-billed estimate reads "This estimate wasn't billed" instead of "No charge". Failure paths are honest: a non-retryable 4xx no longer says "try again", and a terminally rejected auto-actual is now dropped **with a stderr warning** rather than silently. Codex can now close the actuals loop: `on-session-end --transcript <file>` parses the Codex rollout dialect (cumulative `token_count`, cache-read excluded) on a manual foreground path, since Codex has no session-end hook. The MCP handshake version now reflects the real package version.
  - **budgetary-vscode:** the calibration chart renders the full p10–p90 band (a whisker per point) instead of only p50; scenarios are distinguished by marker **shape** (with a legend), not color alone; and the dashboard is accessible to screen readers (labeled regions, a live-region refresh announcement, no color-only signal).

## 0.3.0

### Minor Changes

- f44b900: Request/retry correctness fixes in the HTTP layer:

  - Free-form `metadata` on `submitActuals` now reaches the wire **verbatim** — only known protocol fields are snake-cased, so caller-owned keys (e.g. `toolCalls`) are no longer rewritten.
  - A failed or stalled response-body read is now classified as a `BudgetaryNetworkError` instead of escaping as a raw, unclassified error.
  - An oversized `Retry-After` is clamped to `maxDelay`, so a large or hostile header can no longer stall the client for minutes.
  - 403 now raises a distinct `BudgetaryPermissionError` (previously folded into `BudgetaryAuthError`), so "your key lacks scope" is distinguishable from "bad key". `maxRetries` defaults to `4` (5 total attempts), matching the API contract.

- b4dc94f: Unify API-key resolution behind a single implementation.

  - `@budgetary/sdk` now exports the resolver — `resolveConfigStatus`, `resolveConfig`, the `ConfigStatus` / `ResolvedConfig` types, and the `configFilePath` / `budgetaryDir` path helpers.
  - The mcp server re-exports the shared resolver (its public shape and tests are unchanged) and keeps its own pending-store, language, trace-target, and guidance helpers on top.
  - The VS Code extension drops its private, drifted copy and consumes the shared resolver. **Behavior change:** an _unreadable_ `~/.budgetary/config.json` is now surfaced distinctly ("Config file could not be read") instead of being mislabeled "No API key configured", and the env/file key is trimmed — matching the mcp runtime.

### Patch Changes

- 62c0a20: Fix the dual-published CommonJS type declarations. The CJS build now emits its own `.d.ts` (`tsconfig.cjs.json` `declaration: true`), and the package `exports` map carries per-condition types — `import` and `require` each point at the matching ESM / CJS declarations — with `main` and `types` now pointing at the CJS entry. A CommonJS TypeScript consumer on `moduleResolution: node16` / `nodenext` no longer hits **TS1479** from the ESM `.d.ts` masquerading as CommonJS. CI now runs `@arethetypeswrong/cli` against the packed tarball, so the exports map can't silently regress.

## 0.2.0

### Minor Changes

- 8c3fc92: Forward a measured execution trace to `/v1/actuals`.

  - **SDK:** `ActualsRequest` gains an optional additive `trace` field (`ActualsTraceStep[]` — `{ tool, tokens, kind? }`). It serializes verbatim on the wire; the server classifies it into phases and drops it (without failing the call) if it is over-cap or malformed.
  - **MCP:** the Claude Code `on-session-end` auto path now attaches a per-tool trace alongside the realized total, on the **same cache-read-excluded basis**. Token usage in the real Claude Code transcript is reported **per turn** (per `message.id`), not per tool call, so a multi-tool turn's measured tokens are split evenly across its tools (`kind: "turn-split"`). The trace is real, never model-supplied, capped (≤ 512 steps / 16 KB) and fail-closed — over-cap or unreadable ⇒ the total still submits with no trace.
  - **MCP (correctness):** the transcript parser now **dedupes turn usage by `message.id`**. Real Claude Code transcripts write one JSONL line per content block, each repeating the turn's `usage`; the previous per-line summation over-counted the realized total ~3–4×. Totals are now counted once per turn (verified against real transcripts), which the trace shares.

- 018d606: Enrich the execution trace with a redacted `target` and an `ok` outcome.

  - **SDK:** `ActualsTraceStep` gains two optional additive fields — `target?: string` (a **redacted** descriptor of what the step acted on) and `ok?: boolean` (the measured outcome). Both serialize verbatim on the wire (snake-case-safe); the server reads them to classify and drops anything it doesn't use, exactly as before.
  - **MCP:** the Claude Code `on-session-end` auto path now measures, per step, _which command it ran_ and _whether it succeeded_, on the same submission and basis as the existing trace. `target` is a **redacted** descriptor — for a shell step the program name in the clear (plus the subcommand for a known driver, e.g. `go test`, `npm run`) followed by a **non-reversible** digest of the rest of the command; for a file tool, a bare digest of the path. It **never** carries a raw command, absolute path, file contents, or argument. `ok` is `!is_error` of the matching tool result, omitted when the host flagged no outcome. Both are measured from the transcript, never model-supplied, and fail closed (unreadable ⇒ field omitted; the total + base trace still submit).
  - **Privacy opt-out:** `BUDGETARY_TRACE_TARGET=off` (`0`/`false`/`no`) suppresses `target` entirely; the trace degrades to tool names + token counts (+ the leak-free `ok`). Fail-safe: any other value leaves it on.
  - **Boundary:** the client still classifies nothing — it forwards a program name, a digest, and an error flag; phase labeling and retry detection are server-side. Codex remains deferred (no session-end event); third-party hosts are unchanged.

- e986b70: Forward an optional, declared `context.language` on `/v1/estimate` so estimates can be grouped by the language you're working in.

  - **SDK:** `EstimateContext` gains an optional additive `language?: string` — a benign tag (a host display name such as `TypeScript` or `Python`), same risk class as `host`, forwarded verbatim on the wire (snake-case-safe). The server owns normalization; the SDK ships no alias table.
  - **MCP:** the `estimate` handler now resolves a language tag from the environment — `BUDGETARY_LANGUAGE`, falling back to a `language` field in `~/.budgetary/config.json` — and forwards it on the same `context` as `host`. It is **declared, never model-supplied**: there is deliberately no `language` argument on the `estimate` tool, and it is never inferred from the task text. **Fail-open:** with no signal (or a host that exposes none) the field is omitted entirely and the server records honest `(none)` — it never guesses. The client only reads + trims.
  - **Boundary:** this is a thin additive forward of one field. No engine / `/v1` / server change (the 0022 server already accepts the field, `extra="ignore"`). Claude Code (the first-party host) is wired via the same `@budgetary/mcp` path it already uses; third-party hosts and the hosted `/mcp` endpoint are unchanged (they keep `language = (none)`).

## 0.1.0

### Minor Changes

- First published release (0.1.0).

  - `@budgetary/sdk` and `@budgetary/mcp` ship to npm with build provenance.
    The SDK publishes a dual ESM + CommonJS build (both `import` and `require`
    resolve the public API); the MCP server ships its `budgetary-mcp` bin.
  - `budgetary-vscode` is published to Open VSX.

  No package behaviour changes — this release wires up distribution only.
