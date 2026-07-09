import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Node-only config resolution: the single source of truth for "find the API key
// in BUDGETARY_API_KEY or ~/.budgetary/config.json". Re-exported from the package
// root (see index.ts); the mcp server and the VS Code extension consume it rather
// than each carrying their own (previously drifting) copy.

export const DEFAULT_BASE_URL = "https://api.budgetary.tools";

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  /**
   * Where the resolved key came from, so a later 401 can name the source of the
   * REJECTED key (env is checked first, so a rejected key came from env when set,
   * else the config file).
   */
  source: "env" | "config";
}

/**
 * The outcome of resolving config, distinguishing the two failure modes a bare
 * `null` conflates: no key configured anywhere vs. a config file that exists but
 * cannot be read/parsed (an actionable, different problem).
 */
export type ConfigStatus =
  | { kind: "ok"; config: ResolvedConfig }
  | { kind: "no-key" }
  | { kind: "unreadable"; path: string };

export function budgetaryDir(home?: string): string {
  return join(home ?? homedir(), ".budgetary");
}

export function configFilePath(home?: string): string {
  return join(budgetaryDir(home), "config.json");
}

/**
 * Resolve the API key + base URL and REPORT WHY when there is none, in order:
 *   1. `BUDGETARY_API_KEY` environment variable → `{ kind: "ok", source: "env" }`.
 *   2. `~/.budgetary/config.json` → `{ kind: "ok", source: "config" }`.
 *   3. file present but unreadable / not JSON → `{ kind: "unreadable", path }`.
 *   4. nothing configured → `{ kind: "no-key" }`.
 *
 * The key is returned to in-process callers only; it must never appear in a
 * tool result, log line, or error message.
 */
export function resolveConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): ConfigStatus {
  // Trim so a whitespace-only value counts as "no key" (not a real key that
  // only fails later as a 401), and a stray copy-paste space is tolerated.
  const fromEnv =
    typeof env.BUDGETARY_API_KEY === "string" ? env.BUDGETARY_API_KEY.trim() : "";
  if (fromEnv.length > 0) {
    return {
      kind: "ok",
      config: { apiKey: fromEnv, baseUrl: DEFAULT_BASE_URL, source: "env" },
    };
  }

  const path = configFilePath(home);
  if (!existsSync(path)) return { kind: "no-key" };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "unreadable", path };
  }
  let parsed: { api_key?: unknown; base_url?: unknown };
  try {
    parsed = JSON.parse(raw) as { api_key?: unknown; base_url?: unknown };
  } catch {
    // The file exists but isn't valid JSON — a distinct, fixable problem from
    // "no key at all". Surface it as such rather than pretending nothing is set.
    return { kind: "unreadable", path };
  }
  const apiKey =
    typeof parsed.api_key === "string" ? parsed.api_key.trim() : "";
  if (apiKey.length === 0) {
    return { kind: "no-key" };
  }
  const baseUrl =
    typeof parsed.base_url === "string" && parsed.base_url.length > 0
      ? parsed.base_url
      : DEFAULT_BASE_URL;
  return {
    kind: "ok",
    config: { apiKey, baseUrl, source: "config" },
  };
}

/**
 * Resolve the API key + base URL, in order:
 *   1. `BUDGETARY_API_KEY` environment variable.
 *   2. `~/.budgetary/config.json` → `{ "api_key": "bg_...", "base_url"? }`.
 *   3. `null` — caller renders the configure-key guidance.
 *
 * The key is returned to in-process callers only; it must never appear in a
 * tool result, log line, or error message. Use {@link resolveConfigStatus} when
 * you need to distinguish "no key" from "config unreadable".
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): ResolvedConfig | null {
  const status = resolveConfigStatus(env, home);
  return status.kind === "ok" ? status.config : null;
}
