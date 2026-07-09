---
"@budgetary/mcp": patch
---

Harden local secret handling and bound unbounded reads.

- **Restrict `~/.budgetary` permissions.** The store directory is created owner-only (`0700`) — and an already-loose one is tightened — and `pending.json` is written owner-only (`0600`) via a create-exclusive temp (`wx`, which also refuses to follow a planted symlink). The directory holds `config.json` (the API key) and the file holds pending task queries, so neither should be group/world accessible.
- **Bound the transcript read.** `readTranscriptUsage` size-guards the (caller-supplied) transcript path before reading it whole into memory; an over-cap file fails closed (submits nothing), exactly like any other unreadable input.
- **Bound the stdin accumulator.** The `on-session-end` hook path caps the session-end payload it reads from stdin and fails closed over the cap, so a huge/hostile stdin can't exhaust memory.
- **Validate the key shape on the hook path.** The unattended auto-actuals path now checks the resolved key matches the documented `bg_live_`/`bg_test_` shape (permissively) before use, and skips submission for an unrecognized value.

The Claude Code session-end hook still passes the key on its command line — Claude Code *command* hooks have no `env` map, so the key is briefly visible in the process list on a shared host. This residual and its mitigations (single-user host, `~/.budgetary/config.json` at mode `0600`) are now documented in the plugin README.
