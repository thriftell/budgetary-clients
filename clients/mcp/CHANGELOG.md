# @budgetary/mcp

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

### Patch Changes

- 6f5810a: Expose the package-runner tool (`npx`/`pnpm dlx`/`yarn dlx`/`bunx`) in a step's redacted `target` so server-side test/quality classification works for runner-invoked tooling.

  - **MCP:** the 0019d shell-target redactor gains one more allowlisted-second-token branch. For a package-runner preamble — `npx <tool>`, `bunx <tool>`, `pnpm dlx <tool>`, `yarn dlx <tool>` — the tool that actually runs is exposed as the cleartext second token **iff it is in a fixed runner allowlist** (`jest`, `vitest`, `mocha`, `ava`, `tap`, `jasmine`, `karma`, `cypress`, `playwright`, `tsc`, `eslint`, `biome`, `nyc`, `c8`). So `npx jest …` → `"npx jest <digest>"` and `pnpm dlx playwright test …` → `"pnpm playwright <digest>"`, giving the server (0019c-2) the generic-shell second-token signal it already classifies.
  - **Leak-safety:** membership in the runner allowlist — never a charset — is the gate. A non-allowlisted/private package (`npx my-private-cli`, `npx @acme/secret-codegen`) stays inside the digest and degrades to the bare preamble program (`"npx <digest>"`), exactly today's behavior → server returns `other`. Formatters (`prettier`) are deliberately excluded: formatting is not verification.
  - **Boundary unchanged:** the client still classifies nothing (it forwards a program name + digest; the server labels the phase). Same digest-over-the-whole-normalized-command retry key, same fail-closed posture, same `BUDGETARY_TRACE_TARGET=off` opt-out. Claude Code only; Codex deferred; third-party hosts unchanged. No SDK/`/v1`/engine change.

- Updated dependencies [8c3fc92]
- Updated dependencies [018d606]
- Updated dependencies [e986b70]
  - @budgetary/sdk@0.2.0

## 0.1.1

### Patch Changes

- 15ba2da: Add the `mcpName` field linking `@budgetary/mcp` to its MCP server-registry entry (`io.github.thriftell/budgetary`).

  Listing/metadata only — no tool, runtime, or API behavior change. The MCP registry verifies npm-package ownership by reading `mcpName` from the published tarball, and the already-published `0.1.0` predates the field, so this patch republishes the same server as `0.1.1` with the linking field present.

## 0.1.0

### Minor Changes

- First published release (0.1.0).

  - `@budgetary/sdk` and `@budgetary/mcp` ship to npm with build provenance.
    The SDK publishes a dual ESM + CommonJS build (both `import` and `require`
    resolve the public API); the MCP server ships its `budgetary-mcp` bin.
  - `budgetary-vscode` is published to Open VSX.

  No package behaviour changes — this release wires up distribution only.

### Patch Changes

- Updated dependencies
  - @budgetary/sdk@0.1.0
