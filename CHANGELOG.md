# Changelog

All notable changes to the Budgetary clients are tracked here. Newest first.

## 0012 — MCP client

- New `@budgetary/mcp` server: an MCP `estimate` tool that returns a
  pre-flight token-spend estimate for a coding task and stores it as
  pending. One install wires it into Claude Code, Cursor, Copilot, Codex,
  and other MCP-capable hosts — replacing the planned per-host extensions.
- Actuals close automatically on Claude Code/Codex (real session usage) and
  via a manual `report-actual` command elsewhere; token counts are never
  fabricated by the model.
- Shares `~/.budgetary/` config and `pending.json` with the existing
  first-party clients — configure once across all hosts.
- `context.host` (from BUDGETARY_HOST) tags each estimate by host.
- Handles subscription-gated keys (403) and rate limits (429) gracefully.
- For the dashboard, install `@budgetary/vscode` from Open VSX (unchanged).
- Package version stays `0.0.0`; publishing wires up in 0014.

## 0006 — Codex plugin

- New `@budgetary/codex` plugin: provides a `/estimate <task>` slash command
  (or equivalent host surface) and a session-end hook, mirroring the
  Claude Code plugin's behavior for Codex users.
- Shares `~/.budgetary/pending.json` and the same API-key resolution chain
  with the Claude Code plugin — a user with both installed configures once.
- `context.host = "codex"` on outbound estimates so ledger entries
  distinguish hosts.
- Package version stays `0.0.0`; Codex extension marketplace publishing
  wires up in a later release.

## 0005 — VS Code dashboard extension

- New `@budgetary/vscode` extension: command `Budgetary: Show Dashboard`
  opens a webview with a calibration scatter plot (predicted p50 vs
  actual total tokens, log-log) and a recent-estimates table.
- Hand-written SVG chart, no external chart library; uses VS Code theme
  colors via CSS variables so it matches the user's theme.
- Reads the user's ledger via `/v1/ledger`; never writes anything to the
  API.
- API key resolution is shared with the Claude Code plugin
  (`BUDGETARY_API_KEY` env → `~/.budgetary/config.json` → graceful
  configure-key panel).
- Strict webview CSP; no external resources; nonce-bound inline script.
- Package version stays `0.0.0`; Marketplace + OpenVSX publishing wires
  up in a later release.

## 0004 — Claude Code plugin

- New `@budgetary/claude-code` plugin: provides a `/estimate <task>` slash command
  that calls Budgetary for a pre-flight token-spend estimate, and a session-end
  hook that submits the realized actuals so future estimates calibrate.
- Pending estimates persist under `~/.budgetary/pending.json` so the actuals
  submission survives a Claude Code restart between estimate and execution.
- API key resolution: `BUDGETARY_API_KEY` env var → `~/.budgetary/config.json` →
  graceful "configure your key" hint if neither is set.
- `project_id` is derived from a SHA-256 prefix of the working directory so
  ledger entries group naturally per project without exposing filesystem paths.
- This plugin is the first telemetry-producing client; calibration data starts
  flowing once users install it and run `/estimate`.
- Package version stays `0.0.0`; plugin-marketplace publishing wires up in a
  later release.

## 0003 — Python SDK first implementation

- `budgetary` (Python) now implements `estimate()`, `submit_actuals()`, and
  `get_ledger()` against the v1 API contract, mirroring the TypeScript SDK
  shape and error semantics.
- Sync only in this release; async support lands in a later release.
- Typed exceptions per documented error code; automatic retry on 429 and 5xx
  with exponential backoff and jitter; `Retry-After` honored.
- Optional automatic `client_request_id` generation (UUID v4) for
  safe-by-default retries.
- Single runtime dependency: `httpx`.
- Package version stays `0.0.0`; PyPI publishing wires up in a later release.

## 0002 — TypeScript SDK first implementation

- `@budgetary/sdk` now implements `estimate()`, `submitActuals()`, and `getLedger()`
  against the v1 API contract.
- Typed exceptions for every documented error code; automatic retry on 429 and 5xx
  with exponential backoff and jitter.
- Optional automatic `client_request_id` generation for safe-by-default retries.
- Case conversion at the HTTP boundary: wire payloads are snake_case, SDK surface
  is camelCase.
- Public API contract published at `docs/api-contract.md` (replacing the 0001
  placeholder).
- Package version stays `0.0.0`; npm publishing wires up in a later release.

## 0001 — Bootstrap public clients repo

- Initial monorepo scaffold using pnpm workspaces.
- Empty-but-runnable skeletons for the TypeScript SDK (`@budgetary/sdk`),
  Python SDK (`budgetary`), VS Code extension, Claude Code plugin, and Codex plugin.
- Licensed under Apache-2.0.
- CI runs lint and tests on every PR.
- Publish workflows present as placeholders; no marketplace uploads yet.
