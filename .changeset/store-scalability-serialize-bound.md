---
"@budgetary/mcp": minor
---

Pending-store scalability: serialize concurrent writes, bound growth, surface dropped traces.

- **Serialize the read-modify-write.** The shared `~/.budgetary/pending.json` was mutated under an unlocked read → mutate → write, so at 2–10 parallel agent sessions two writers off one snapshot last-writer-win — silently dropping a calibration pair *after* "stored ✓". Every store mutation (`append`, the session-end submit's remove/bump/drop, the TTL sweep) now runs under a fail-open advisory lock (`pending.json.lock`, O_EXCL, ~8 jittered retries, 10 s stale-break, released in `finally`). On contention it **fails open** to the prior unlocked behavior rather than risk the 30 s hook budget. A regression test proves 40 concurrent appending processes lose zero entries (they lose several with the lock disabled).
- **Bound hook-less growth.** Hosts without a session-end hook (Codex/Cursor/Copilot) never sweep, so their queue grew unbounded (~12.5k entries/yr). `append` now sweeps expired entries (24h TTL, shared rule), hard-caps at 1,000 entries with oldest-eviction, and truncates the stored `query` to 160 chars (it is local-only, never sent to the server). Stale `pending.json.*.tmp` orphans from a crashed writer are reaped opportunistically.
- **Honest trace-drop.** When a session's execution trace exceeds the cap it is dropped whole (a trimmed trace would misstate composition) — previously this was silent and read identically to a tool-free run. The drop is now recorded on the session-end breadcrumb ("trace over cap: N steps / M bytes — totals only") and emitted under `BUDGETARY_DEBUG`. No wire field changes; totals still submit.
