import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConfigEnv {
  env: NodeJS.ProcessEnv;
  home?: string;
}

export interface ResolvedKey {
  apiKey: string;
  source: "env" | "config_file";
}

export function budgetaryDir(env: ConfigEnv = { env: process.env }): string {
  return join(env.home ?? homedir(), ".budgetary");
}

export function configFilePath(env: ConfigEnv = { env: process.env }): string {
  return join(budgetaryDir(env), "config.json");
}

export function pendingFilePath(env: ConfigEnv = { env: process.env }): string {
  return join(budgetaryDir(env), "pending.json");
}

export function resolveApiKey(
  env: ConfigEnv = { env: process.env },
): ResolvedKey | null {
  const fromEnv = env.env.BUDGETARY_API_KEY;
  if (fromEnv && fromEnv.length > 0) {
    return { apiKey: fromEnv, source: "env" };
  }

  const path = configFilePath(env);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { api_key?: unknown };
    if (typeof parsed.api_key === "string" && parsed.api_key.length > 0) {
      return { apiKey: parsed.api_key, source: "config_file" };
    }
  } catch {
    // Treat unreadable / malformed config as "no key"; callers will print the hint.
  }
  return null;
}

export function noKeyHint(): string {
  return [
    "Budgetary is installed but no API key is configured.",
    "Set BUDGETARY_API_KEY in your environment, or run:",
    "  mkdir -p ~/.budgetary && echo '{ \"api_key\": \"bg_live_...\" }' > ~/.budgetary/config.json",
  ].join("\n");
}
