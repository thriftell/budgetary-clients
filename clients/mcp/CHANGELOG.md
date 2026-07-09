# @budgetary/mcp

## 0.2.4

### Patch Changes

- b564e75: Harden local secret handling and bound unbounded reads.

  - **Restrict `~/.budgetary` permissions.** The store directory is created owner-only (`0700`) — and an already-loose one is tightened — and `pending.json` is written owner-only (`0600`) via a create-exclusive temp (`wx`, which also refuses to follow a planted symlink). The directory holds `config.json` (the API key) and the file holds pending task queries, so neither should be group/world accessible.
  - **Bound the transcript read.** `readTranscriptUsage` size-guards the (caller-supplied) transcript path before reading it whole into memory; an over-cap file fails closed (submits nothing), exactly like any other unreadable input.
  - **Bound the stdin accumulator.** The `on-session-end` hook path caps the session-end payload it reads from stdin and fails closed over the cap, so a huge/hostile stdin can't exhaust memory.
  - **Validate the key shape on the hook path.** The unattended auto-actuals path now checks the resolved key matches the documented `bg_live_`/`bg_test_` shape (permissively) before use, and skips submission for an unrecognized value.

  The Claude Code session-end hook still passes the key on its command line — Claude Code _command_ hooks have no `env` map, so the key is briefly visible in the process list on a shared host. This residual and its mitigations (single-user host, `~/.budgetary/config.json` at mode `0600`) are now documented in the plugin README.

- 09fc5d1: Harden the execution-trace redaction so nothing sensitive can reach the wire in the clear.

  - **Program name is now allowlist-gated, not charset-gated.** A shell step's cleartext program is exposed only when it is on a fixed allowlist of common, non-sensitive tools (`pytest`, `npm`, `go`, `git`, …). A pasted credential (`ghp_…`, `sk-…`), a private script name (`rotate_prod_keys.sh`), or any other free-form first token now degrades to a bare digest with no cleartext. Also caps the program length and rejects known secret prefixes as belt-and-suspenders.
  - **Digests are now salted (non-reversible).** Redaction digests use HMAC-SHA256 instead of a plain truncated SHA-256. The trace `target` digest uses a fresh per-submission salt (retry-equality still holds within one submission); `project_id` uses a machine-local install salt persisted at `~/.budgetary/install-salt` (owner-only), so it stays stable per install while the salt-less server cannot dictionary-reverse it back to a path or command. The salts never leave the machine.
  - **Env-assignment peel fails closed on a backslash.** A leading `VAR=val` whose value ends in a backslash (an escaped space / line-continuation) no longer splits mid-value and surfaces a later token as the program.
  - **Tool names are allowlisted.** Custom/internal MCP tool names (e.g. an org-private `mcp__acme__…`) are bucketed to `mcp:other` instead of being forwarded verbatim.
  - **Trace-target opt-out fails safe.** `BUDGETARY_TRACE_TARGET` now stays ON only for an explicit affirmative (`1`/`true`/`on`/`yes`) or the unset/blank default; any other value (including a typo like `disabled`) resolves to OFF.
  - **Build cleans `dist` first** so a stale artifact can't ship on a local publish.

  Behavior deltas (mainline unchanged): a normal command's `target` is identical except its digest is now salted; a first token that is not an allowlisted program is emitted as a bare digest rather than in the clear; `project_id` becomes a per-install salted value (a one-time regrouping of a user's historical ledger); an unrecognized `BUDGETARY_TRACE_TARGET` value now disables the descriptor instead of leaving it on. README and the API contract no longer overclaim an unsalted digest as "non-reversible".

- Updated dependencies [b647e1c]
  - @budgetary/sdk@0.4.0

## 0.2.3

### Patch Changes

- 4509caa: Declare `zod` as a direct dependency (`^4.0.0`) instead of relying on it as an auto-installed peer of `@modelcontextprotocol/sdk`, so strict installs (`auto-install-peers=false`, Yarn PnP) resolve it reliably. Also declare `engines: { node: ">=22" }`, which the code already assumes.
- Updated dependencies [4509caa]
  - @budgetary/sdk@0.3.2

## 0.2.2

### Patch Changes

- 80118ca: Changelog backfill for the dim-2 "honest presentation" UX pass. These user-facing changes shipped functionally in `@budgetary/sdk` 0.3.0 / `@budgetary/mcp` 0.2.1 / `budgetary-vscode` 0.1.2 but were released without a changeset, so they never reached the changelog. Recorded here for an honest history — there is no code change beyond this note.

  - **@budgetary/sdk:** `normalizeScenario` is now exported (an unknown scenario label folds to `uncertain`); `scenario` is widened to `Scenario | (string & {})` so an unknown server label is not a type error; the constructor now throws on an empty/whitespace API key instead of failing later with an opaque 401; and `void`, `distribution`, `confidence`, and `expiresAt` gained JSDoc.
  - **@budgetary/mcp:** estimates are presented honestly — a confident estimate leads with the point, while an uncertain / sparse-evidence / unknown one leads with the range and a caution note, and a non-billed estimate reads "This estimate wasn't billed" instead of "No charge". Failure paths are honest: a non-retryable 4xx no longer says "try again", and a terminally rejected auto-actual is now dropped **with a stderr warning** rather than silently. Codex can now close the actuals loop: `on-session-end --transcript <file>` parses the Codex rollout dialect (cumulative `token_count`, cache-read excluded) on a manual foreground path, since Codex has no session-end hook. The MCP handshake version now reflects the real package version.
  - **budgetary-vscode:** the calibration chart renders the full p10–p90 band (a whisker per point) instead of only p50; scenarios are distinguished by marker **shape** (with a legend), not color alone; and the dashboard is accessible to screen readers (labeled regions, a live-region refresh announcement, no color-only signal).

- Updated dependencies [80118ca]
  - @budgetary/sdk@0.3.1

## 0.2.1

### Patch Changes

- f44b900: Pending-store and actuals-submission integrity fixes:

  - Actuals are now bound to their own session (matched by `project_id`) before submission, so a session's realized counts can no longer be attached to a different concurrent session's estimate.
  - The shared `~/.budgetary/pending.json` no longer loses data under concurrency: the store is re-read immediately before each write, the target entry is removed by `estimate_id` rather than by position, each writer uses a unique temp file, and a single malformed entry no longer discards the whole file (an unreadable/corrupt store is left intact instead of clobbered).
  - The session-end submit persists its attempt bump **before** the network call and uses a bounded client (short retry/timeout), so a hook killed on session exit still advances toward the give-up bound instead of retrying forever, and a failing submit can't hang the host's exit.
  - `success` defaults to `false` unless a real termination signal is present.

- b4dc94f: Unify API-key resolution behind a single implementation.

  - `@budgetary/sdk` now exports the resolver — `resolveConfigStatus`, `resolveConfig`, the `ConfigStatus` / `ResolvedConfig` types, and the `configFilePath` / `budgetaryDir` path helpers.
  - The mcp server re-exports the shared resolver (its public shape and tests are unchanged) and keeps its own pending-store, language, trace-target, and guidance helpers on top.
  - The VS Code extension drops its private, drifted copy and consumes the shared resolver. **Behavior change:** an _unreadable_ `~/.budgetary/config.json` is now surfaced distinctly ("Config file could not be read") instead of being mislabeled "No API key configured", and the env/file key is trimmed — matching the mcp runtime.

- Updated dependencies [f44b900]
- Updated dependencies [62c0a20]
- Updated dependencies [b4dc94f]
  - @budgetary/sdk@0.3.0

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
