---
"@budgetary/mcp": minor
---

Submit a finished Claude Code session's real token counts automatically, on the next estimate.

An install wired with `claude mcp add` has the `estimate` tool and no session-end hook, so a completed run was never reported. It turns out nothing was missing but a moment to act: a stdio MCP server is told by Claude Code which session spawned it and where that project's transcripts live, and a session that has ended leaves a complete transcript behind. The next `estimate` reads that transcript and closes out the earlier run.

- Each pending estimate now records which session made it, which call it was, and which process served it — all from the host, none of it from the model, and none of it sent to the server.
- A later estimate closes out at most one earlier run whose serving process has exited, measuring it from that run's own transcript with the same reader the hook uses. Counts and execution trace are identical to what the hook would have sent.
- Every step fails closed. No binding, no transcript, an unreadable or unparseable one, or one that changes while being read all mean nothing is submitted and the run stays pending for a later estimate.
- A run is only ever matched to its own transcript, proven by the host's own identifier for the call rather than assumed from a name. A run it cannot prove is left alone.
- The estimate itself is untouched: the work is scheduled after the response has been sent, so it cannot delay the result, change its text, or make it fail. When there is nothing to close out, no transcript is opened at all.

The session-end hook remains the primary path and still fires at the better moment: it can report how a session ended, which a later reader cannot. Submissions are settled by estimate id, so whichever path arrives first wins and the other is discarded — either order leaves exactly one result and nothing counted twice.

The tool surface is unchanged: `estimate` remains the only model-invokable tool, and no path accepts a model-supplied token count.
