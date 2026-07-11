---
"@budgetary/mcp": minor
---

Add operator self-service and stop the silent-hang: `main()` dispatched only 3
subcommands, so `--version`, `--help`, and any typo fell through to
`runStdioServer()` and blocked — the documented `npx -y @budgetary/mcp` smoke
test looked like a freeze, and there was no way to check connectivity/key/config
short of a billed estimate.

- **No silent hang.** Only a bare invocation (no arguments) starts the stdio
  server. `--version`/`-v`/`version` prints the version; `--help`/`-h`/`help`
  prints usage; an unknown subcommand prints usage to stderr and exits 2. A
  one-line version banner is written to **stderr** at server start (stdout stays
  the JSON-RPC channel) so a bare launch shows a sign of life.
- **`doctor` subcommand.** Prints the version, the key **source + prefix**
  (`bg_live_`/`bg_test_` — never the value), the **resolved base URL**, the
  pending path + count, and the last automatic-run breadcrumb; then makes ONE
  authenticated `GET /v1/ledger?limit=1` (the existing endpoint — no new API,
  `maxRetries: 0`) and classifies the result through the SDK's error taxonomy
  (200 / 401 / 403 / 429-is-valid / network-names-the-host).
- **Config transparency (O-7).** `doctor` (and the new `configDiagnostics`) warn
  when a config-file `base_url` was **refused** (non-HTTPS → silently fell back to
  the prod default) or **shadowed** by an env key that short-circuits before the
  file is read. Traffic could otherwise hit prod while the operator believed
  otherwise — surfacing the resolved URL + the reason is the fix.
