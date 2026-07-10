import { defineConfig } from "tsup";

// Bundle the stdio MCP server so the published package no longer pulls the MCP
// SDK's HTTP-server stack (express/hono/jose/eventsource/cors/…, ~95 packages /
// ~22 MB on a cold `npx -y @budgetary/mcp`), none of which the stdio server
// reaches. (ajv + the JSON-schema stack it uses stay, bundled into the output.)
// The two entries mirror the package `exports` map; `splitting` hoists the code
// they share (all of `actuals.ts`, which `server.ts` imports) into one chunk.
//
// `@budgetary/sdk` is kept EXTERNAL (not bundled): it stays a real, exact-pinned
// runtime `dependency`, so changesets auto-republishes @budgetary/mcp whenever
// the workspace SDK changes, and an SDK fix reaches the fleet without even
// rebuilding this bundle. It is a first-party, zero-dependency package, so a cold
// `npx` fetches just the mcp bundle plus that one tiny tarball. The MCP SDK and
// zod ARE bundled (devDependencies) — they are frozen at build time, so bumping
// either needs an mcp changeset (see CONTRIBUTING).
//
// `minify: false` is deliberate: this is a public, npm-provenanced package, so
// the shipped bytes stay auditable. The bundled third-party (MIT/…) license
// texts are collected into dist/THIRD-PARTY-NOTICES.txt by the post-build
// script (the build command); `legalComments: 'eof'` additionally preserves any
// inline banners, though the current bundled deps carry none.
export default defineConfig({
  entry: ["src/server.ts", "src/actuals.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: true,
  // Keep the workspace SDK external so the `dependencies` edge (and its
  // changesets auto-republish) is preserved; everything else is bundled.
  external: ["@budgetary/sdk"],
  // Emit .d.ts for both entries. `./actuals` (the typed first-party extension
  // point) resolves standalone — it references only `@budgetary/sdk`, a real
  // runtime dependency. The `.` (low-level server) entry's types additionally
  // reference the bundled `@modelcontextprotocol/sdk`; a consumer of that server
  // API installs the MCP SDK itself. (tsup's dts bundler does not inline that
  // package's type tree, and `@budgetary/sdk` must stay an import anyway — its
  // `BudgetaryClient` has a private field, so an inlined copy would be nominally
  // incompatible with a consumer's own client. attw --profile esm-only is green
  // for both entries and gates this in CI.)
  dts: true,
  // Emit the esbuild metafile so the license collector knows exactly which
  // third-party packages were bundled.
  metafile: true,
  sourcemap: false,
  clean: true,
  minify: false,
  esbuildOptions(options) {
    options.legalComments = "eof";
  },
});
