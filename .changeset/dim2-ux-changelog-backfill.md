---
"@budgetary/sdk": patch
"@budgetary/mcp": patch
"budgetary-vscode": patch
---

Changelog backfill for the dim-2 "honest presentation" UX pass. These user-facing changes shipped functionally in `@budgetary/sdk` 0.3.0 / `@budgetary/mcp` 0.2.1 / `budgetary-vscode` 0.1.2 but were released without a changeset, so they never reached the changelog. Recorded here for an honest history — there is no code change beyond this note.

- **@budgetary/sdk:** `normalizeScenario` is now exported (an unknown scenario label folds to `uncertain`); `scenario` is widened to `Scenario | (string & {})` so an unknown server label is not a type error; the constructor now throws on an empty/whitespace API key instead of failing later with an opaque 401; and `void`, `distribution`, `confidence`, and `expiresAt` gained JSDoc.
- **@budgetary/mcp:** estimates are presented honestly — a confident estimate leads with the point, while an uncertain / sparse-evidence / unknown one leads with the range and a caution note, and a non-billed estimate reads "This estimate wasn't billed" instead of "No charge". Failure paths are honest: a non-retryable 4xx no longer says "try again", and a terminally rejected auto-actual is now dropped **with a stderr warning** rather than silently. Codex can now close the actuals loop: `on-session-end --transcript <file>` parses the Codex rollout dialect (cumulative `token_count`, cache-read excluded) on a manual foreground path, since Codex has no session-end hook. The MCP handshake version now reflects the real package version.
- **budgetary-vscode:** the calibration chart renders the full p10–p90 band (a whisker per point) instead of only p50; scenarios are distinguished by marker **shape** (with a legend), not color alone; and the dashboard is accessible to screen readers (labeled regions, a live-region refresh announcement, no color-only signal).
