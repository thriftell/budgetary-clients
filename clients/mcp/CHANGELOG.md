# @budgetary/mcp

## 0.1.1

### Patch Changes

- 15ba2da: Add the `mcpName` field linking `@budgetary/mcp` to its MCP server-registry entry (`io.github.thriftell/budgetary`).

  Listing/metadata only — no tool, runtime, or API behavior change. The MCP registry verifies npm-package ownership by reading `mcpName` from the published tarball, and the already-published `0.1.0` predates the field, so this patch republishes the same server as `0.1.1` with the linking field present.

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
