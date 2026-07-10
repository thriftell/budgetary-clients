---
"@budgetary/mcp": patch
---

Bundle the server so its heavy runtime dependencies drop from 3 to 1.

`@budgetary/mcp` is launched with `npx -y @budgetary/mcp` — a fresh install on
every (pinned) version bump and in every ephemeral environment (devcontainers,
cloud sandboxes). Two of its three runtime dependencies (`@modelcontextprotocol/sdk`
and `zod`) transitively pulled the MCP SDK's entire HTTP-server stack — express,
hono, jose, eventsource, cors, cross-spawn — about 95 packages / ~22 MB /
~3,600 files on a cold `npx`, none of which the stdio server reaches.

The package now builds with tsup (esbuild) and bundles `@modelcontextprotocol/sdk`
and `zod` into a single self-contained tree (the HTTP stack tree-shakes away; the
JSON-schema validation the SDK actually uses — ajv and its deps — is retained,
bundled into the output). Those two move to
`devDependencies`. `@budgetary/sdk` is deliberately kept as an external,
exact-pinned runtime `dependency` (not bundled), so changesets keeps
auto-republishing `@budgetary/mcp` whenever the workspace SDK changes and an SDK
fix reaches the fleet without a bundle rebuild. A cold `npx -y @budgetary/mcp`
now downloads the one mcp bundle plus that single zero-dependency SDK tarball —
two small packages instead of 95 / ~22 MB.

The output is intentionally unminified (this is a public, npm-provenanced
package, so the shipped bytes stay auditable), and the bundled third-party
license notices are collected into `dist/THIRD-PARTY-NOTICES.txt` at build time.

No public API or runtime behavior change: the `exports` map, `bin`, the
`estimate` tool surface, and the `initialize` + `tools/list` handshake are
identical, and the version is still read from the package's own `package.json`
at runtime. Verified with a stdio handshake run against only the bundle plus the
external SDK (the MCP HTTP stack absent), `attw` (green under the esm-only
profile, now also gated in CI), and a packed `dependencies` of just
`@budgetary/sdk`.
