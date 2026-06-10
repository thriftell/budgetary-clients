import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://api.budgetary.tools";

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
}

export function budgetaryDir(home?: string): string {
  return join(home ?? homedir(), ".budgetary");
}

export function configFilePath(home?: string): string {
  return join(budgetaryDir(home), "config.json");
}

export function pendingFilePath(home?: string): string {
  return join(budgetaryDir(home), "pending.json");
}

/**
 * Resolve the API key + base URL, in order:
 *   1. `BUDGETARY_API_KEY` environment variable.
 *   2. `~/.budgetary/config.json` → `{ "api_key": "bg_...", "base_url"? }`.
 *   3. `null` — caller renders the configure-key guidance.
 *
 * The key is returned to in-process callers only; it must never appear in a
 * tool result, log line, or error message.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): ResolvedConfig | null {
  const fromEnv = env.BUDGETARY_API_KEY;
  if (fromEnv && fromEnv.length > 0) {
    return { apiKey: fromEnv, baseUrl: DEFAULT_BASE_URL };
  }

  const path = configFilePath(home);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { api_key?: unknown; base_url?: unknown };
    if (typeof parsed.api_key !== "string" || parsed.api_key.length === 0) {
      return null;
    }
    const baseUrl =
      typeof parsed.base_url === "string" && parsed.base_url.length > 0
        ? parsed.base_url
        : DEFAULT_BASE_URL;
    return { apiKey: parsed.api_key, baseUrl };
  } catch {
    // Treat unreadable / malformed config as "no key"; callers print the hint.
  }
  return null;
}

/** Guidance returned when no API key is configured. Never echoes any value. */
export function noKeyGuidance(): string {
  return [
    "Budgetary has no API key configured, so it cannot estimate this task.",
    "",
    "Set one of the following, then try again:",
    "  • the BUDGETARY_API_KEY environment variable for this MCP host, or",
    "  • ~/.budgetary/config.json containing { \"api_key\": \"bg_...\" }",
    "",
    "Free testing keys start with bg_test_; production keys start with bg_live_.",
    "Get a key at https://budgetary.tools",
  ].join("\n");
}
