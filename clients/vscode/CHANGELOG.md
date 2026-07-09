# budgetary-vscode

## 0.1.4

### Patch Changes

- Updated dependencies [4509caa]
  - @budgetary/sdk@0.3.2

## 0.1.3

### Patch Changes

- 80118ca: Changelog backfill for the dim-2 "honest presentation" UX pass. These user-facing changes shipped functionally in `@budgetary/sdk` 0.3.0 / `@budgetary/mcp` 0.2.1 / `budgetary-vscode` 0.1.2 but were released without a changeset, so they never reached the changelog. Recorded here for an honest history — there is no code change beyond this note.

  - **@budgetary/sdk:** `normalizeScenario` is now exported (an unknown scenario label folds to `uncertain`); `scenario` is widened to `Scenario | (string & {})` so an unknown server label is not a type error; the constructor now throws on an empty/whitespace API key instead of failing later with an opaque 401; and `void`, `distribution`, `confidence`, and `expiresAt` gained JSDoc.
  - **@budgetary/mcp:** estimates are presented honestly — a confident estimate leads with the point, while an uncertain / sparse-evidence / unknown one leads with the range and a caution note, and a non-billed estimate reads "This estimate wasn't billed" instead of "No charge". Failure paths are honest: a non-retryable 4xx no longer says "try again", and a terminally rejected auto-actual is now dropped **with a stderr warning** rather than silently. Codex can now close the actuals loop: `on-session-end --transcript <file>` parses the Codex rollout dialect (cumulative `token_count`, cache-read excluded) on a manual foreground path, since Codex has no session-end hook. The MCP handshake version now reflects the real package version.
  - **budgetary-vscode:** the calibration chart renders the full p10–p90 band (a whisker per point) instead of only p50; scenarios are distinguished by marker **shape** (with a legend), not color alone; and the dashboard is accessible to screen readers (labeled regions, a live-region refresh announcement, no color-only signal).

- Updated dependencies [80118ca]
  - @budgetary/sdk@0.3.1

## 0.1.2

### Patch Changes

- f44b900: Dashboard correctness fixes:

  - The calibration chart escapes the scenario label in point tooltips and looks up scenario colors as own-properties only, so an unusual label can't break the SVG.
  - Pending (not-yet-completed) estimates are shown as rows instead of the dashboard reporting "No estimates yet" on a non-empty ledger.
  - Concurrent and refresh loads are sequenced (newest-wins) and guarded against a disposed panel, so a slow response can't overwrite newer content or throw.
  - The recent-estimates table tolerates an unparseable date without breaking its sort order.

- b4dc94f: Unify API-key resolution behind a single implementation.

  - `@budgetary/sdk` now exports the resolver — `resolveConfigStatus`, `resolveConfig`, the `ConfigStatus` / `ResolvedConfig` types, and the `configFilePath` / `budgetaryDir` path helpers.
  - The mcp server re-exports the shared resolver (its public shape and tests are unchanged) and keeps its own pending-store, language, trace-target, and guidance helpers on top.
  - The VS Code extension drops its private, drifted copy and consumes the shared resolver. **Behavior change:** an _unreadable_ `~/.budgetary/config.json` is now surfaced distinctly ("Config file could not be read") instead of being mislabeled "No API key configured", and the env/file key is trimmed — matching the mcp runtime.

- Updated dependencies [f44b900]
- Updated dependencies [62c0a20]
- Updated dependencies [b4dc94f]
  - @budgetary/sdk@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [8c3fc92]
- Updated dependencies [018d606]
- Updated dependencies [e986b70]
  - @budgetary/sdk@0.2.0

## 0.1.0

### Minor Changes

- First published release (0.1.0).

  - `@budgetary/sdk` and `@budgetary/mcp` ship to npm with build provenance.
    The SDK publishes a dual ESM + CommonJS build (both `import` and `require`
    resolve the public API); the MCP server ships its `budgetary-mcp` bin.
  - `budgetary-vscode` is published to Open VSX.

  No package behaviour changes — this release wires up distribution only.

### Patch Changes

- Updated dependencies
  - @budgetary/sdk@0.1.0
