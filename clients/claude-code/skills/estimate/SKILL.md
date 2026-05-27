---
name: estimate
description: Get a Budgetary pre-flight token-spend estimate for a task before running it. Use whenever the user wants to know how many tokens a task is likely to consume before doing it.
argument-hint: "[task description]"
disable-model-invocation: false
---

The user invoked `/estimate` with the argument: `$ARGUMENTS`.

Run the bundled Node CLI to fetch a Budgetary estimate and print it verbatim. Use the `Bash` tool with this exact command (substituting the argument for `<ARGS>`):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/estimate.mjs" -- <ARGS>
```

`${CLAUDE_PLUGIN_ROOT}` is set by Claude Code to this plugin's install directory. The CLI prints a human-readable block describing the estimate (or a configuration hint if the API key is not set). Show the CLI's stdout to the user without modification — do not rewrite it, summarize it, or add commentary.

If the CLI exits non-zero, show stderr verbatim. Do not retry — the SDK has already retried internally.
