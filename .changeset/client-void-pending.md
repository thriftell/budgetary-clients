---
"@budgetary/mcp": minor
---

feat: record outcomes for out-of-domain (void) estimates too

The client now writes a pending entry whenever the estimate response carries an
`estimate_id` — including a **void** (out-of-domain) estimate, not just a
confident one. A void still shows the same "cannot confidently estimate …
proceed at your own judgment" message; what changes is that its real outcome is
now recordable — `on-session-end` pairs the actual to the void's `estimate_id`,
exactly as it does for a confident estimate.

Previously a void wrote no pending entry, so out-of-domain outcomes were silently
dropped — which are precisely the ones needed to measure the engine where it
cannot yet predict. No forecast band is stored for a void (there is none); the
entry pairs on the id alone. No server or `/v1` contract change.
