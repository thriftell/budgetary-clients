---
"@budgetary/sdk": minor
"@budgetary/mcp": patch
---

Fleet good-citizenship: de-synchronize retries and honor host cancellation.

- **Jitter above the `Retry-After` floor (both SDKs).** The 429 backoff was `min(max(retryAfter, computed), maxDelay)` — deterministic, so a correlated fleet all seeing the same `Retry-After: 1` at a fixed-window boundary re-synchronized into one bucket and thundering-herd'd the engine the instant the window opened (demonstrated: 40/40 clients collapse into one 1 s bucket). It is now `min(retryAfter*1000 + random()*computed, maxDelay)` — the server's floor still holds and the clamp still bounds a hostile header, but jitter is added on top so the fleet spreads across `[retryAfter, retryAfter+computed)`. Same change in the Python SDK (`_internal/retry.py`); existing floor/clamp tests unchanged, an injected-random de-sync test added to each.
- **Honor host cancellation (TS SDK + MCP).** `estimate` gained a `signal?: AbortSignal` option. The MCP server now threads the host's per-request `AbortSignal` (`extra.signal`) through `handleCallTool` → `runEstimateTool` → `estimate`, combined with the per-attempt timeout via `AbortSignal.any`, and the retry backoff sleep is signal-aware. So a host that abandons an interactive estimate stops retrying immediately — shedding load exactly during a shared outage — instead of finishing its full ~5 min ladder against a struggling engine for a result no one will read. (The unattended actuals path is already `maxRetries: 0`; the Python sync client has no host-cancel channel — N/A.)
