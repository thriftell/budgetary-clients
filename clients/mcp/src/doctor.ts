import {
  BudgetaryAuthError,
  BudgetaryClient,
  BudgetaryError,
  BudgetaryNetworkError,
  BudgetaryPermissionError,
  BudgetaryRateLimitError,
  type BudgetaryClientOptions,
} from "@budgetary/sdk";

import { breadcrumbForecastVsActual, describeAge } from "./actuals.js";
import { readBreadcrumb, type SessionEndBreadcrumb } from "./breadcrumb.js";
import { configDiagnostics, pendingFilePath, resolveConfig } from "./config.js";
import { PendingStore } from "./store.js";
import { SERVER_VERSION } from "./version.js";

export interface DoctorArgs {
  env: NodeJS.ProcessEnv;
  home?: string;
  /** Write one line to the operator (stdout in the CLI). */
  out: (line: string) => void;
  now?: () => Date;
  /** Override the SDK client (tests). */
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
}

/** One honest line describing the last automatic (session-end hook) run. */
function describeBreadcrumb(crumb: SessionEndBreadcrumb, now: Date): string {
  const age = describeAge(crumb.startedAt, now);
  if (crumb.outcome === undefined || crumb.durationMs === undefined) {
    return `started ${age}, did not finish (interrupted)`;
  }
  const id = crumb.estimateId
    ? ` ${crumb.estimateId.length > 12 ? `${crumb.estimateId.slice(0, 12)}…` : crumb.estimateId}`
    : "";
  // Close the loop when the run recorded counts: "forecast ~M → actual N".
  const compare = breadcrumbForecastVsActual(crumb);
  const cmp = compare ? ` — ${compare}` : "";
  return `${crumb.outcome}${id}, ${age}${cmp}`;
}

/** Map a connectivity failure onto the SDK's existing error taxonomy. */
function classifyConnectivity(err: unknown, baseUrl: string): string {
  if (err instanceof BudgetaryAuthError) {
    return "✗ the API key was rejected (401) — check the key.";
  }
  if (err instanceof BudgetaryPermissionError) {
    return "✗ the key is valid but has no active plan (403) — start one at https://budgetary.tools";
  }
  if (err instanceof BudgetaryRateLimitError) {
    return "⚠ rate limited (429) — the key IS valid; the API is just busy. Try again shortly.";
  }
  if (err instanceof BudgetaryNetworkError) {
    return `✗ couldn't reach ${baseUrl} (${err.message}).`;
  }
  if (err instanceof BudgetaryError) {
    const rid = err.requestId ? ` (request_id: ${err.requestId})` : "";
    return `✗ the API returned an error: ${err.message}${rid}.`;
  }
  return `✗ ${err instanceof Error ? err.message : String(err)}.`;
}

/** Print the local pending-store state + the last automatic-run breadcrumb. */
function printLocalState(args: DoctorArgs, now: Date): void {
  const path = pendingFilePath(args.home);
  // The store never throws on read (it degrades to empty + warns), so a count is
  // always available without risking the doctor itself faulting.
  const count = new PendingStore({ path }).read().entries.length;
  args.out(
    `Pending:   ${count} ${count === 1 ? "estimate" : "estimates"} awaiting actuals (${path})`,
  );
  const crumb = readBreadcrumb(args.home);
  args.out(
    crumb !== null
      ? `Last auto: ${describeBreadcrumb(crumb, now)}`
      : "Last auto: (no automatic session-end run recorded yet)",
  );
}

/**
 * `doctor`: the operator's self-service check, so connectivity / key / config
 * can be confirmed WITHOUT a billed estimate. Prints the version, the key SOURCE
 * and prefix (never the value), the RESOLVED base URL (+ any refused/shadowed
 * config warning), the pending path/count, and the last automatic-run breadcrumb;
 * then makes ONE authenticated read (`GET /v1/ledger?limit=1`, the existing
 * endpoint — no new API) and classifies the result through the SDK's error
 * taxonomy. Returns 0 only when connectivity succeeds.
 */
export async function runDoctor(args: DoctorArgs): Promise<number> {
  const { out } = args;
  const now = (args.now ?? (() => new Date()))();

  out(`Budgetary MCP v${SERVER_VERSION}`);

  const diag = configDiagnostics(args.env, args.home);
  if (diag.source === "none") {
    out("API key:   (none configured)");
    out(
      "           Set BUDGETARY_API_KEY, or ~/.budgetary/config.json { \"api_key\": \"bg_...\" }.",
    );
    printLocalState(args, now);
    out("Connectivity: skipped — configure a key first. Get one at https://budgetary.tools");
    return 1;
  }
  if (diag.source === "unreadable") {
    out("API key:   (config file present but unreadable — invalid JSON?)");
    printLocalState(args, now);
    out("Connectivity: skipped — fix ~/.budgetary/config.json first.");
    return 1;
  }

  // Key present. Show SOURCE + PREFIX (never the value) and the RESOLVED base URL.
  out(`API key:   ${diag.keyPrefix}… (source: ${diag.source})`);
  out(`Base URL:  ${diag.baseUrl}`);
  for (const w of diag.warnings) out(`⚠ ${w}`);
  printLocalState(args, now);

  // The KEY VALUE is read here (in-process only, never printed) purely to build
  // the client for the connectivity probe.
  const resolved = resolveConfig(args.env, args.home);
  if (resolved === null) {
    // Unreachable given diag.source is env/config, but stay honest if it happens.
    out("Connectivity: skipped — the key could not be re-read.");
    return 1;
  }

  const factory =
    args.clientFactory ??
    ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  // maxRetries: 0 — doctor must answer promptly, not sit through a 429/5xx ladder.
  const client = factory({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    maxRetries: 0,
  });

  try {
    await client.getLedger({ limit: 1 });
    out(`Connectivity: ✓ reached ${diag.baseUrl} and the key was accepted (HTTP 200).`);
    return 0;
  } catch (err) {
    out(`Connectivity: ${classifyConnectivity(err, diag.baseUrl ?? resolved.baseUrl)}`);
    return 1;
  }
}
