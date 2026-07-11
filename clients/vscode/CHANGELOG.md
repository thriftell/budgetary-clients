# budgetary-vscode

## 0.1.7

### Patch Changes

- 3dd43a2: Keep the dashboard responsive when the ledger call fails. The webview now builds
  its `BudgetaryClient` with `maxRetries: 0`: a `429 Retry-After` (clamped to 60 s)
  or a 5xx retry ladder would otherwise pin the panel on "Loading…" for up to
  ~4 minutes before showing anything. The visible Retry/refresh button IS the
  retry, so the failure now surfaces promptly. The ledger response is also
  shape-guarded — a malformed page (`entries` not an array) reads as an honest
  "unexpected response" instead of throwing out of the renderer.
- 1e3ec4a: Sharpen the status surfaces so they under-report trouble less and make the
  `estimate_id` pairing key visible.

  **@budgetary/mcp**

  - `pending` rows now carry the facts that matter: `• <excerpt> — 3h ago,
4/5 attempts, measured ✓, expires in ~1h, id est_ab12…`. `attempts` shows how
    close an entry is to the give-up cap; `measured ✓` marks an entry whose counts
    were already captured on a prior failed submit (a retry resends those); the
    expiry names the 24h auto-window and notes that manual `report-actual` still
    works past it.
  - The `estimate_id` (short form) is now visible where it was invisible before:
    in the estimate render footer, in the manual/rollout submit confirmations, and
    on every `pending` row — the same short id across all three, so a user can
    correlate an estimate with its pending entry and its submission.
  - `request_id` is threaded into the auth (401), permission (403), and
    rate-limit (429) renderers, matching the transport-error renderers.
  - Honest terminal copy: an empty queue no longer claims "the loop is closed"
    (some estimates may have been dropped — gave-up / rejected / TTL-swept, which
    the last-run breadcrumb reports).

  **budgetary-vscode**

  - The dashboard surfaces the out-of-coverage void rate ("2 of the last 50
    estimates were out-of-coverage voids") from `scenario === "out_of_domain"`.
  - Out-of-domain rows render their Result cell as "no prediction" instead of the
    misleading "○ pending" — a void never receives an actual.
  - `out_of_domain` is dropped from the chart legend (it is never plotted as a
    marker, so its swatch advertised a shape the chart never draws); it still
    appears in the table's Scenario column.

- Updated dependencies [a475a2f]
  - @budgetary/sdk@0.5.0

## 0.1.6

### Patch Changes

- Updated dependencies [4965932]
  - @budgetary/sdk@0.4.1

## 0.1.5

### Patch Changes

- Updated dependencies [b647e1c]
  - @budgetary/sdk@0.4.0

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
