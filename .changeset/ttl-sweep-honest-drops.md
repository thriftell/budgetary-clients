---
"@budgetary/mcp": patch
---

Sweep the pending store honestly at session end. `runAutoActuals` now drops
EVERY entry older than the 24h TTL — not just the one this session would close —
so an abandoned project's estimate can't live in the queue forever (nothing else
ever selected it, so nothing ever expired it). The sweep re-reads first (so a
concurrent append isn't clobbered) and emits a single warning naming the count,
closing the last silent drop path. An unparseable or future `created_at` has an
unknown age and is deliberately KEPT rather than discarded — dropping it could
silently lose a session's own actual.
