---
"@budgetary/mcp": patch
---

Trim session-end hook latency, behavior-preserving.

- **Cap retries on the non-interactive actuals submit paths.** The auto
  session-end hook, the rollout `on-session-end --transcript`, and the manual
  `report-actual` now construct the SDK client with `maxRetries: 0` (no
  in-process retry). During a server outage the SDK's default ladder (4 retries,
  ~7.5–15 s of backoff sleeps) would run inside the 30 s session-end host budget
  and delay process exit; and because the SDK honors a `429` `Retry-After` as a
  floor (clamped to 60 s), even a single retry could sleep past the budget and
  get the hook killed mid-wait — the exact hang this cap prevents. A failed
  submit stays pending and is retried on a later session (durable cross-session
  retry), which is strictly better than blocking exit on in-process sleeps. The
  interactive `estimate` path is deliberately left at the full retry ladder — a
  user is waiting there for the result.
- **Parse each Claude Code transcript once.** The Codex-dialect probe now
  fast-rejects when the `token_count` marker is absent (the dominant Claude Code
  hook path), instead of doing a full `split` + per-line `JSON.parse` that the
  per-turn parser then repeats. A coincidental `token_count` in a Claude
  transcript is harmless — the probe runs as before and still falls through.
