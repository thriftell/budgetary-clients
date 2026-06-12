---
name: estimate
description: Get a Budgetary pre-flight token-spend estimate for a task before running it. Use whenever the user wants to know how many tokens a task is likely to consume before doing it.
---

The user has asked for a Budgetary estimate. The task description should come from the user's surrounding prompt; if it is missing, ask what they want estimated before doing anything else.

Call the Budgetary **`estimate`** tool — provided by the bundled `budgetary` MCP server — passing the task description as the `query` argument. Show the tool's result to the user verbatim: do not rewrite it, summarize it, or add commentary.

The tool returns a pre-flight token-spend estimate (a token range, a scenario label, and a confidence score) and records the estimate locally. If no API key is configured, the tool returns a short configure-your-key hint instead — show that verbatim too.

Do not call the tool with an empty query, and do not invent a token number yourself: the estimate must come from the tool.
