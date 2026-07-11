import { createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Whether a resolved key matches the documented `bg_live_` / `bg_test_` shape.
 *
 * Defense-in-depth for the Claude Code session-end HOOK: that host has no env map
 * for command hooks, so the plugin key is interpolated into the shell command
 * (`BUDGETARY_API_KEY="${user_config.api_key}" npx …`) and is briefly visible in
 * the process list — a documented residual. Validating the shape before the
 * unattended auto path uses it stops a garbage/injected value from reaching the
 * wire. Deliberately PERMISSIVE on the body (any non-whitespace) so a real key is
 * never rejected; only the stable, documented prefix is required.
 */
export function looksLikeBudgetaryKey(key: string): boolean {
  return /^bg_(live|test)_\S+$/.test(key);
}

export function pendingFilePath(home?: string): string {
  return join(budgetaryDir(home), "pending.json");
}

export function installSaltPath(home?: string): string {
  return join(budgetaryDir(home), "install-salt");
}

/**
 * A per-install random secret used to salt the non-reversible `project_id` (and
 * available to any other digest that must stay STABLE across runs while resisting
 * a dictionary). It is generated once and persisted at
 * `~/.budgetary/install-salt` (owner-only), then reused, so the derived id is
 * stable for one install yet not reversible by the server — the salt never
 * leaves the machine.
 *
 * **Cross-run stability is load-bearing:** the estimate and the session-end hook
 * run as separate `npx @budgetary/mcp` processes, and an actual binds to its
 * estimate by matching `project_id`. So this must return the SAME salt on every
 * run, never a per-process one — otherwise the binding silently breaks and the
 * measured actual is lost. To hold that even when the persisted file is present
 * but unusable (empty/truncated/garbage/dangling-symlink) it self-heals:
 *   1. a valid persisted salt is reused;
 *   2. an absent file is created exclusively (`wx`, `0600`);
 *   3. an unusable file is REPAIRED in place — removed (symlink-safe: `unlink`
 *      targets the link/name, never follows it) and recreated exclusively;
 *   4. only when nothing can be persisted at all (a read-only `HOME`, or a
 *      foreign-owned/immutable path) does it fall back to a DETERMINISTIC salt
 *      derived from the config dir, which is still stable across runs so the
 *      binding survives — it is simply not salted with machine-private entropy
 *      in that rare, unpersistable case.
 * Never throws.
 */
export function installSalt(home?: string): Buffer {
  const path = installSaltPath(home);
  const existing = readInstallSalt(path);
  if (existing !== null) return existing;

  const salt = randomBytes(32);
  const hex = salt.toString("hex");
  try {
    const dir = budgetaryDir(home);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `wx` is create-exclusive (O_CREAT|O_EXCL): a concurrent writer never
    // clobbers another's salt, and it will not follow/overwrite a pre-existing
    // symlink. `0600` keeps the secret owner-only.
    writeFileSync(path, hex, { flag: "wx", mode: 0o600 });
    return salt;
  } catch {
    // Either we lost the create race, or a name already exists at the path but
    // is unusable (empty/truncated/garbage/symlink/dir/foreign-owned).
    const raced = readInstallSalt(path);
    if (raced !== null) return raced; // a concurrent healthy writer won

    // Repair an unusable file so future runs are stable. `unlink` removes the
    // link/name itself (it does NOT follow a symlink to its target), then a
    // fresh exclusive create restores a valid owner-only salt.
    try {
      unlinkSync(path);
      writeFileSync(path, hex, { flag: "wx", mode: 0o600 });
      return salt;
    } catch {
      // Truly cannot persist (read-only HOME, foreign-owned/immutable path, or a
      // directory at the name). Return a DETERMINISTIC salt so `project_id`
      // stays STABLE across runs and processes and the binding survives.
      return readInstallSalt(path) ?? deterministicFallbackSalt(home);
    }
  }
}

/**
 * A stable, process-independent fallback salt for the rare case where no salt
 * can be persisted. Derived from the config dir so it is identical across runs
 * and both processes (preserving the estimate↔actual binding). NOT salted with
 * machine-private entropy — this path is only reached when a per-install secret
 * cannot be stored at all.
 */
function deterministicFallbackSalt(home?: string): Buffer {
  return createHmac("sha256", "budgetary/install-salt/v1")
    .update(budgetaryDir(home))
    .digest();
}

/** Read the persisted install salt, or `null` when absent/unreadable/malformed. */
function readInstallSalt(path: string): Buffer | null {
  try {
    const hex = readFileSync(path, "utf8").trim();
    // At least 16 bytes of lowercase hex; anything else is treated as absent.
    if (/^[0-9a-f]{32,}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    // absent / unreadable → the caller generates a fresh salt
  }
  return null;
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
 * salted, non-reversible digest, or a bare path digest) that carries no raw
 * path, argument, or command. A privacy-conscious operator opts out by setting
 * `BUDGETARY_TRACE_TARGET` to an off-value (`0` / `false` / `off` / `no`), which
 * suppresses `target` entirely: the trace degrades to the prior
 * `{ tool, tokens, kind? }` shape plus the leak-free `ok` flag, and the realized
 * total is unaffected.
 *
 * Fail-safe toward the LESS-disclosing direction: it stays ON only when the
 * variable is absent/blank (the default) or an explicit affirmative
 * (`1` / `true` / `on` / `yes`). Any other set value — including a typo like
 * `disabled` or `redacted` — resolves to OFF, so a misremembered opt-out never
 * silently keeps sending the descriptor.
 */
export function traceTargetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.BUDGETARY_TRACE_TARGET;
  if (typeof v !== "string") return true; // unset → default ON
  const norm = v.trim().toLowerCase();
  if (norm === "") return true; // blank → treated as unset (default ON)
  // Allowlist of affirmatives; every other set value (off-values AND
  // unrecognized typos) resolves to OFF — the safe direction.
  return norm === "1" || norm === "true" || norm === "on" || norm === "yes";
}

/**
 * Read the RAW `base_url` a config file declares (before the HTTPS gate), or
 * `null` when absent / unreadable / empty. Diagnostics-only: it lets `doctor`
 * notice a config `base_url` that {@link resolveConfigStatus} silently REFUSED
 * (non-HTTPS → fell back to the prod default) or that an env key SHADOWED (an env
 * key short-circuits before the file is read). Mirrors resolveConfigStatus's
 * own non-trimming string test so the comparison is apples-to-apples.
 */
function readConfigBaseUrl(home?: string): string | null {
  const path = configFilePath(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { base_url?: unknown };
    if (typeof parsed.base_url === "string" && parsed.base_url.length > 0) {
      return parsed.base_url;
    }
  } catch {
    // Unreadable / malformed config carries no usable base_url signal.
  }
  return null;
}

/** Non-secret, printable view of how config resolved — for `doctor`. */
export interface ConfigDiagnostics {
  /** `env` / `config` when a key resolved; `none` / `unreadable` otherwise. */
  source: "env" | "config" | "none" | "unreadable";
  /** The resolved base URL, or `null` when no key resolved. */
  baseUrl: string | null;
  /** The key's public prefix — NEVER the value — or `null` when no key resolved. */
  keyPrefix: "bg_live_" | "bg_test_" | "unrecognized" | null;
  /** Human warnings about a refused or shadowed config `base_url` (may be empty). */
  warnings: string[];
}

/**
 * Resolve config into a PRINTABLE diagnostic view — source, resolved base URL,
 * key prefix (never the key), and warnings about a config `base_url` that was
 * silently refused (non-HTTPS) or shadowed by an env key. Traffic can otherwise
 * hit prod while the operator believes it points elsewhere; surfacing the
 * resolved URL + the reason is the fix. Deliberately carries NO secret so it is
 * always safe to print in full.
 */
export function configDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): ConfigDiagnostics {
  const status = resolveConfigStatus(env, home);
  const warnings: string[] = [];
  const rawBase = readConfigBaseUrl(home);

  if (status.kind === "ok") {
    const { source, baseUrl, apiKey } = status.config;
    const keyPrefix = apiKey.startsWith("bg_live_")
      ? "bg_live_"
      : apiKey.startsWith("bg_test_")
        ? "bg_test_"
        : "unrecognized";
    // A config base_url that differs from the resolved one was either shadowed
    // by an env key (env source, file never read) or refused (config source,
    // non-HTTPS → prod default). Either surprises the operator; name it.
    if (rawBase !== null && rawBase !== baseUrl) {
      if (source === "env") {
        warnings.push(
          `an env BUDGETARY_API_KEY is set, so ~/.budgetary/config.json is not read — ` +
            `its base_url ${JSON.stringify(rawBase)} is ignored; using ${baseUrl}.`,
        );
      } else {
        warnings.push(
          `config.json base_url ${JSON.stringify(rawBase)} was refused (not https:// or ` +
            `localhost) — using ${baseUrl} instead so the API key isn't sent in cleartext.`,
        );
      }
    }
    return { source, baseUrl, keyPrefix, warnings };
  }
  if (status.kind === "unreadable") {
    return { source: "unreadable", baseUrl: null, keyPrefix: null, warnings };
  }
  return { source: "none", baseUrl: null, keyPrefix: null, warnings };
}

/**
 * Whether verbose session-end diagnostics are enabled. Default OFF: the
 * unattended hook is silent on the happy path (stdout is the JSON-RPC channel;
 * stderr is shown by the host only in debug mode), so an operator turns this on
 * — `BUDGETARY_DEBUG=1` in the MCP host config's env — to have the hook narrate
 * every decision on stderr while it chases a lost actual.
 *
 * Opt-IN and fail-safe toward SILENT: it is ON only for an explicit affirmative
 * (`1` / `true` / `on` / `yes`, case-insensitive). Any other value — a typo, an
 * off-value — stays OFF, so a misremembered flag never floods stderr.
 */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.BUDGETARY_DEBUG;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on" || norm === "yes";
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
