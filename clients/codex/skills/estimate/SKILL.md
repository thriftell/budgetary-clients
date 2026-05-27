---
name: estimate
description: Get a Budgetary pre-flight token-spend estimate for a task before running it. Use whenever the user wants to know how many tokens a task is likely to consume before doing it.
---

The user has asked for a Budgetary estimate. The task description should come from the user's surrounding prompt.

Run the bundled Node CLI to fetch the estimate and print it verbatim. Use the shell with this exact command (substituting the user's task description for `<TASK>`):

```
node "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/estimate.mjs" -- <TASK>
```

`PLUGIN_ROOT` is set by Codex to this plugin's install directory; `CLAUDE_PLUGIN_ROOT` is the compatibility alias. The CLI prints a human-readable block describing the estimate (or a configuration hint if the API key is not set). Show the CLI's stdout to the user without modification — do not rewrite it, summarize it, or add commentary.

If the CLI exits non-zero, show stderr verbatim. Do not retry — the SDK has already retried internally.
