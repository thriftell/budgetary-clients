---
"@budgetary/sdk": minor
"@budgetary/mcp": minor
---

Enrich the execution trace with a redacted `target` and an `ok` outcome.

- **SDK:** `ActualsTraceStep` gains two optional additive fields — `target?: string` (a **redacted** descriptor of what the step acted on) and `ok?: boolean` (the measured outcome). Both serialize verbatim on the wire (snake-case-safe); the server reads them to classify and drops anything it doesn't use, exactly as before.
- **MCP:** the Claude Code `on-session-end` auto path now measures, per step, *which command it ran* and *whether it succeeded*, on the same submission and basis as the existing trace. `target` is a **redacted** descriptor — for a shell step the program name in the clear (plus the subcommand for a known driver, e.g. `go test`, `npm run`) followed by a **non-reversible** digest of the rest of the command; for a file tool, a bare digest of the path. It **never** carries a raw command, absolute path, file contents, or argument. `ok` is `!is_error` of the matching tool result, omitted when the host flagged no outcome. Both are measured from the transcript, never model-supplied, and fail closed (unreadable ⇒ field omitted; the total + base trace still submit).
- **Privacy opt-out:** `BUDGETARY_TRACE_TARGET=off` (`0`/`false`/`no`) suppresses `target` entirely; the trace degrades to tool names + token counts (+ the leak-free `ok`). Fail-safe: any other value leaves it on.
- **Boundary:** the client still classifies nothing — it forwards a program name, a digest, and an error flag; phase labeling and retry detection are server-side. Codex remains deferred (no session-end event); third-party hosts are unchanged.
