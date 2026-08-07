---
"@budgetary/mcp": minor
---

Tell a hook-less Claude Code install that nothing is submitting its completed runs, and how to fix it.

`claude mcp add` wires the `estimate` tool only — the SessionEnd hook that submits realized token counts ships with the plugin. Until now nothing said so at runtime, so an install on that path could estimate indefinitely, never contribute a completed run, and never be told.

- `doctor` gains an `Actuals:` line reporting whether an automatic session-end submission has ever run on this machine, and printing the exact hook to add if none has. On a machine without Claude Code it offers the routes that host actually has instead.
- The first estimate on such an install says the same thing once.
- Both only ever print. Nothing in this package reads or writes your Claude Code configuration.
- The README documents wiring the hook without the plugin, and submitting a finished session by hand from its transcript — counts measured, never typed.

On the estimate path an install that can already contribute sees nothing new: the notice is suppressed by the plugin manifest's `BUDGETARY_SESSION_END` declaration or by any recorded session-end run. `doctor` gains its status line for everyone, which is the point of a diagnostic.

The tool surface is unchanged: `estimate` remains the only model-invokable tool, and no path accepts a model-supplied token count.
