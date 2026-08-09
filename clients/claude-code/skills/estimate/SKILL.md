---
name: estimate
description: Get a Budgetary pre-flight token-spend estimate for a task before running it. Use whenever the user wants to know how many tokens a task is likely to consume before doing it.
argument-hint: "[task description]"
disable-model-invocation: false
---

The user invoked `/estimate` with the argument: `$ARGUMENTS`.

Call the Budgetary **`estimate`** tool (provided by the bundled `budgetary` MCP server) with the task description as the `query` argument. Show the tool's result to the user verbatim — do not rewrite it, summarize it, or add commentary.

The tool returns a pre-flight token-spend estimate (a token range, a scenario label, and a confidence score) and records the estimate so the same run's realized spend can be measured automatically when the session ends. Where there is no firm basis to forecast a particular task it returns no range at all — that abstention IS the result; show it verbatim and do not re-ask with a reworded query, which bills a second estimate. If no API key is configured, the tool returns a short configure-your-key hint instead — show that verbatim too.

If `$ARGUMENTS` is empty, ask the user what task they want estimated before calling the tool. Do not call the tool with an empty query.
