---
"@budgetary/mcp": minor
---

The one-time hook-less notice now detects Claude Code from the MCP handshake. The `initialize` request already carries the host's own name (`clientInfo.name`), so when `BUDGETARY_HOST` is unset the notice gate reads that instead of staying silent forever. An explicit `BUDGETARY_HOST` always wins; the match is exact and case-sensitive against a frozen allowlist with one verified entry (`claude-code`); an unrecognised, absent, malformed or empty identity asserts nothing. Nothing sent or recorded changes — the estimate's host tag still resolves from the environment and still defaults to `mcp`.
