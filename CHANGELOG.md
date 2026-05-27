# Changelog

All notable changes to the Budgetary clients are tracked here. Newest first.

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
