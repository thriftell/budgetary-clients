---
"@budgetary/sdk": minor
"@budgetary/mcp": minor
---

Forward two content-free change counts on `/v1/actuals` so the server can report whether spend converted into edits that stuck.

- **SDK:** `ActualsRequest` gains two optional additive integers — `producedChanges?` and `acceptedChanges?` — that serialize on the wire as `produced_changes` / `accepted_changes` (snake-case-safe). They are counts only; the server derives any cost-per-accepted efficiency view and drops what it doesn't use, exactly as with `trace`.
- **MCP:** the Claude Code `on-session-end` auto path now measures, from the SAME mutate-family events (`Edit`/`Write`/`MultiEdit`) the trace already parses, two discrete counts and forwards them on the existing actuals POST:
  - `produced_changes` — **successful** file-mutating tool calls, counted as **discrete events (not lines, not content)**. A failed or denied edit does not count.
  - `accepted_changes` — of those, how many were **still present at session close**. A change is decremented when a later successful edit/write to the **same file** superseded it within the session — a deliberately **conservative, under-counting** within-session survival proxy (the client is content-blind, so it never claims a change survived when it can't tell a revert from an unrelated later edit). Always `≤ produced_changes`.
- **Counts, not content.** Exactly two integers leave the machine — **no file paths, diffs, file contents, or change text** — a stronger privacy position than the trace's redacted `target` (there is nothing to redact). **Measured, never fabricated:** both come from observed transcript events, there is no model-invokable tool that can write them, and hosts that expose no per-edit events (Cursor/Copilot/Codex) or a run whose survival can't be determined omit them. **Fail-closed:** a missing change signal never fails or alters the actuals submission — the token total is the contract; the counts are additive. **Opt-out:** `BUDGETARY_TRACE_TARGET=off` suppresses the counts along with the trace descriptor.
- **Efficiency, not productivity; the client classifies nothing.** The server turns the counts into a cost-per-accepted efficiency signal (coverage-gated, "vs tasks like yours"); the client does no classification, scoring, or benchmarking. Reverts performed by other tools (`rm`, `git checkout`) and durable, cross-session (N-day) persistence are out of scope here — measured server-side over time, never on the client. Claude Code only; Codex deferred; third-party hosts unchanged.
