import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_BASE_URL,
  budgetaryDir,
  configFilePath,
  resolveConfig,
  resolveConfigStatus,
  type ConfigStatus,
  type ResolvedConfig,
} from "@budgetary/sdk";

// Key resolution lives in @budgetary/sdk (the single source of truth). This
// module re-exports it so mcp's public shape and tests are unchanged, and adds
// the mcp-specific pending-store path, language, trace-target, and guidance
// helpers on top of the shared `~/.budgetary` convention.
export {
  DEFAULT_BASE_URL,
  budgetaryDir,
  configFilePath,
  resolveConfig,
  resolveConfigStatus,
};
export type { ConfigStatus, ResolvedConfig };

export function pendingFilePath(home?: string): string {
  return join(budgetaryDir(home), "pending.json");
}

/**
 * Resolve the optional, deterministically-**declared** language tag to forward
 * as `context.language`, in order:
 *   1. `BUDGETARY_LANGUAGE` environment variable (set by the host or operator,
 *      never by the model), or
 *   2. `~/.budgetary/config.json` → `{ "language": "..." }`.
 *
 * Returns the trimmed value, or `undefined` when no signal exists. This is the
 * same posture as {@link resolveConfig} for `host`: a benign behavior tag read
 * from the environment, never inferred from the task text and never a
 * model-writable tool argument. The client only reads + trims — the server owns
 * normalization (so there is deliberately no client-side alias table). A stdio
 * MCP server receives MCP messages, not editor state, so there is no reliable
 * per-call/active-file signal; this declared value (session-static granularity)
 * is the floor. **Fail-open:** any absent, empty, or unreadable signal returns
 * `undefined` so the caller omits the field and the server records honest
 * `(none)` — it never guesses a language.
 */
export function resolveLanguage(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): string | undefined {
  const fromEnv = env.BUDGETARY_LANGUAGE;
  if (typeof fromEnv === "string") {
    const trimmed = fromEnv.trim();
    if (trimmed.length > 0) return trimmed;
  }

  const path = configFilePath(home);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { language?: unknown };
    if (typeof parsed.language === "string") {
      const trimmed = parsed.language.trim();
      if (trimmed.length > 0) return trimmed;
    }
  } catch {
    // Unreadable / malformed config carries no language signal. Fail-open.
  }
  return undefined;
}

/**
 * Whether the auto path may attach the redacted `target` descriptor to trace
 * steps. Defaults to ON — `target` is a redacted descriptor (program name +
 * non-reversible digest, or a bare path digest) that carries no raw path,
 * argument, or command. A privacy-conscious operator opts out by setting
 * `BUDGETARY_TRACE_TARGET` to `0` / `false` / `off` / `no`, which suppresses
 * `target` entirely: the trace degrades to the prior `{ tool, tokens, kind? }`
 * shape plus the leak-free `ok` flag, and the realized total is unaffected.
 *
 * Fail-safe: only the explicit opt-out values disable it; any other or absent
 * value leaves the default ON.
 */
export function traceTargetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.BUDGETARY_TRACE_TARGET;
  if (typeof v !== "string") return true;
  const norm = v.trim().toLowerCase();
  return !(norm === "0" || norm === "false" || norm === "off" || norm === "no");
}

/**
 * Guidance returned when the key can't be resolved. Never echoes any value.
 * Host-aware: on `claude-code` it leads with the plugin's configure command.
 * `kind: "unreadable"` distinguishes a broken config file from no key at all, so
 * the user fixes the right thing instead of being told to set a key they set.
 */
export function noKeyGuidance(
  host?: string,
  kind: "no-key" | "unreadable" = "no-key",
): string {
  if (kind === "unreadable") {
    return [
      "Budgetary found ~/.budgetary/config.json but couldn't read it (invalid JSON?),",
      "so it has no API key to use. Fix that file, or set BUDGETARY_API_KEY, then try again.",
      "Get a key at https://budgetary.tools",
    ].join("\n");
  }

  const lines = [
    "Budgetary has no API key configured, so it cannot estimate this task.",
    "",
  ];
  if (host === "claude-code") {
    lines.push(
      "Configure it with `/plugin configure budgetary@budgetary`, or set one of:",
    );
  } else {
    lines.push("Set one of the following, then try again:");
  }
  lines.push(
    "  • the BUDGETARY_API_KEY environment variable (checked first), or",
    "  • ~/.budgetary/config.json containing { \"api_key\": \"bg_...\" }",
    "",
    "Free testing keys start with bg_test_; production keys start with bg_live_.",
    "Get a key at https://budgetary.tools",
  );
  return lines.join("\n");
}
