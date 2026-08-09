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
import {
  claudeCodePresent,
  contributionStatus,
  DATA_DISCLOSURE_BODY,
  sessionEndHookLines,
} from "./contribution.js";
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
  printContribution(args);
  printDataDisclosure(args);
}

/**
 * What leaves this machine — stated EVERY time `doctor` runs.
 *
 * ★ The secondary home, with a different job from the one-time block appended to
 * a first estimate. `doctor` is not the disclosure MOMENT: thinking to run it
 * already requires suspecting the thing it would disclose, so it closes nothing
 * on its own. What it is, is the place a user who lost the block — scrolled past
 * it, cleared the transcript, or never saw it because an unwritable home made
 * the marker claim fail — can always read it again. That fail-toward-silence
 * failure mode is the entire reason this line is unconditional rather than
 * once-only.
 *
 * Printed from {@link DATA_DISCLOSURE_BODY} rather than re-authored, so the two
 * surfaces cannot drift. The one-time block's own lead ("…one estimate late…")
 * is deliberately not reused: there is no estimate this call is late for.
 *
 * Placed inside `printLocalState` so it reaches EVERY branch, including the two
 * early returns for a missing or unreadable key. Someone whose setup is not
 * finished is exactly the person who has not read anything else either.
 */
function printDataDisclosure(args: DoctorArgs): void {
  const [first, ...rest] = DATA_DISCLOSURE_BODY;
  args.out(`Data:      ${first}`);
  for (const line of rest) args.out(`           ${line}`);
}

/**
 * Whether completed runs on this machine have an automatic way to be submitted —
 * the one state `doctor` could not previously report, and the one a bare
 * `claude mcp add` silently gets wrong. `claude mcp add` wires the estimate tool
 * alone; the SessionEnd hook ships with the plugin. Without it a user estimates
 * indefinitely and never contributes a single realized run, with nothing anywhere
 * saying so.
 *
 * ★ The negative branch is an OBSERVATION AND AN OFFER, never a verdict. The
 * detection behind it is positive-only and cannot prove absence (see
 * {@link contributionStatus}), so this says "nothing has been recorded here" —
 * which is exactly what we know — and then offers both fixes. It deliberately
 * mirrors the shape of the no-key branch above: state what is missing, say what
 * it costs, give the command.
 *
 * Printed in EVERY branch, including no-key: whether the hook is wired is a
 * property of the install, independent of whether a key resolves or the API is
 * reachable, and it is precisely the user with an unfinished setup who most needs
 * to see it.
 */
function printContribution(args: DoctorArgs): void {
  const { out } = args;
  const status = contributionStatus(args.env, args.home);
  if (status.kind === "auto") {
    out(
      // Each branch cites its own evidence. `declared` is a statement the
      // launching manifest made, not one we verified — say so rather than
      // asserting the hook is wired.
      status.via === "declared"
        ? "Actuals:   automatic — the launching manifest declares a session-end hook."
        : "Actuals:   automatic — a session-end run has been recorded here (see 'Last auto' above).",
    );
    return;
  }
  out("Actuals:   no automatic session-end submission has been recorded on this machine.");
  // The signal is retrospective — a breadcrumb exists only AFTER a session-end
  // run — so a correctly wired hook reads as "nothing recorded" until it first
  // fires. Say that here, or a user who just pasted the hook below (or who is
  // running the plugin and has not ended a session yet) reads this as "my edit
  // did not take" and undoes the very fix this block exists to deliver.
  out("           If you run the Budgetary plugin, or just wired the hook, that is expected");
  out("           until your next session ends — it appears above under 'Last auto:'.");
  // Conditional, and deliberately so. `report-actual` and `on-session-end
  // --transcript` submit real actuals but write no breadcrumb, so this block
  // never retracts for someone using them. An unconditional "completed runs are
  // never submitted" would therefore be permanently FALSE for every manual host
  // — telling a Cursor user who submits by hand every day that they contribute
  // nothing. State the conditional instead; it is true for everyone.
  out("           Otherwise nothing submits for you automatically, and a completed run");
  out("           cannot improve future estimates unless it is submitted — by hook or by hand.");
  // `doctor` runs in the user's shell and cannot know the host (see
  // `claudeCodePresent`), so the Claude-Code-only recipe is shown only where
  // Claude Code is actually installed.
  if (claudeCodePresent(args.home)) {
    out("           On Claude Code you can wire it once — add this to ~/.claude/settings.json");
    out("           (nothing writes it for you):");
    for (const line of sessionEndHookLines("             ")) out(line);
    out("           The hook reads your key from ~/.budgetary/config.json, keeping it out of");
    out("           the process list. The Budgetary plugin ships this hook already.");
  }
  out("           To submit a finished session by hand instead — counts measured from the");
  out("           transcript, never typed — run from the directory you estimated in:");
  out("             npx @budgetary/mcp on-session-end --transcript <session transcript>");
  out("             Claude Code: ~/.claude/projects/<project>/<session-id>.jsonl");
  out("             Codex:       ~/.codex/sessions/rollout-<ts>-<uuid>.jsonl");
  out("           On a host that writes no transcript (Cursor, Copilot, and others), record");
  out("           the counts yourself: npx @budgetary/mcp report-actual");
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
