---
"@budgetary/mcp": patch
---

Pending-store and actuals-submission integrity fixes:

- Actuals are now bound to their own session (matched by `project_id`) before submission, so a session's realized counts can no longer be attached to a different concurrent session's estimate.
- The shared `~/.budgetary/pending.json` no longer loses data under concurrency: the store is re-read immediately before each write, the target entry is removed by `estimate_id` rather than by position, each writer uses a unique temp file, and a single malformed entry no longer discards the whole file (an unreadable/corrupt store is left intact instead of clobbered).
- The session-end submit persists its attempt bump **before** the network call and uses a bounded client (short retry/timeout), so a hook killed on session exit still advances toward the give-up bound instead of retrying forever, and a failing submit can't hang the host's exit.
- `success` defaults to `false` unless a real termination signal is present.
