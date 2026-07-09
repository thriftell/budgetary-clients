// Key resolution lives in @budgetary/sdk (the single source of truth). The
// extension previously carried its own copy that had drifted from the runtime:
// it lacked the key-trim and collapsed an *unreadable* config file to `null`
// (the "No API key configured" panel), hiding a broken file behind a wrong
// message. Re-exporting the shared resolver fixes that — callers can now use
// `resolveConfigStatus()` to tell "no key" apart from "config unreadable".
export {
  DEFAULT_BASE_URL,
  configFilePath,
  resolveConfig,
  resolveConfigStatus,
} from "@budgetary/sdk";
export type { ConfigStatus, ResolvedConfig } from "@budgetary/sdk";
