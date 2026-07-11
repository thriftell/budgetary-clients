import { readFileSync } from "node:fs";

/**
 * The package version, read from the package's own package.json so it always
 * matches the published `@budgetary/mcp` rather than drifting from a hard-coded
 * literal. `src/version.ts` and `dist/version.js` are both one level below the
 * package root, so `../package.json` resolves in both. Falls back to `0.0.0` if
 * it can't be read (never throws at import time).
 *
 * Extracted into its own module so the server, the `doctor` command, and the
 * CLI `--version` banner share ONE source of truth without a circular import.
 */
function readServerVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = readServerVersion();
