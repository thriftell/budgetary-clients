---
"@budgetary/sdk": minor
"@budgetary/mcp": patch
"budgetary-vscode": patch
---

Unify API-key resolution behind a single implementation.

- `@budgetary/sdk` now exports the resolver — `resolveConfigStatus`, `resolveConfig`, the `ConfigStatus` / `ResolvedConfig` types, and the `configFilePath` / `budgetaryDir` path helpers.
- The mcp server re-exports the shared resolver (its public shape and tests are unchanged) and keeps its own pending-store, language, trace-target, and guidance helpers on top.
- The VS Code extension drops its private, drifted copy and consumes the shared resolver. **Behavior change:** an *unreadable* `~/.budgetary/config.json` is now surfaced distinctly ("Config file could not be read") instead of being mislabeled "No API key configured", and the env/file key is trimmed — matching the mcp runtime.
