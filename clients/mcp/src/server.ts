import { createInterface } from "node:readline/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  runAutoActuals,
  runManualActuals,
  runPendingList,
  runRolloutActuals,
  type SessionEndPayload,
} from "./actuals.js";
import { configDiagnostics } from "./config.js";
import { runDoctor } from "./doctor.js";
import { TOOL_USE_ID_META } from "./session.js";
import { runEstimateTool, type HandshakeClientInfo } from "./tools/estimate.js";
import { SERVER_VERSION } from "./version.js";

const SERVER_NAME = "budgetary";

/**
 * Upper bound on the session-end JSON envelope read from stdin. The real payload
 * is a small object; a larger stdin is hostile or a mistaken pipe, so the read is
 * bounded to avoid memory exhaustion and then fails closed (exit 0).
 */
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

// The handshake/CLI version. Re-exported so existing importers (and tests) keep
// resolving it from `server.js`; the single source of truth lives in version.ts.
export { SERVER_VERSION };

/** The one and only model-invokable tool name. */
export const TOOL_NAME = "estimate";

const ESTIMATE_TOOL: Tool = {
  name: TOOL_NAME,
  title: "Budgetary: estimate token spend",
  // ⚠ The FINAL clause used to end "it never reports how many tokens a run
  // actually used", which 0026c makes false: a run whose actuals were recorded
  // earlier now has its measured breakdown rendered beneath a later estimate.
  // The live-usage disclaimer is what mattered in that clause and it is kept —
  // this tool still observes nothing about the run it is called during — while
  // the post-hoc half is now conditional on the recording having happened.
  // Nothing before the em-dash is touched here; that copy is a separate item's.
  description:
    "Return a pre-flight, probabilistic token-spend estimate for a coding " +
    "task before you run it, and store it so the realized cost can be " +
    "recorded afterward. Call this with the user's task described in natural " +
    "language. Returns a token range (p10–p90), a scenario label, and a " +
    "confidence score. This tool only estimates and records — it does not " +
    "observe the current run's usage; when an earlier run's counts have been " +
    "recorded, it reports that run's measured breakdown.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language description of the coding task to estimate.",
      },
      model: {
        type: "string",
        description:
          "Optional target model identifier (e.g. claude-opus-4-7). Omit to " +
          "use the account default.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/**
 * Every tool the server exposes. Exported so tests can assert that the surface
 * is exactly `estimate` and that no tool accepts model-supplied token counts.
 */
export const TOOLS: Tool[] = [ESTIMATE_TOOL];

/** Injectable dependencies for {@link handleCallTool} (tests). */
export interface CallToolDeps {
  /** Override the estimate tool (tests); defaults to {@link runEstimateTool}. */
  runEstimate?: typeof runEstimateTool;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  /**
   * The host's per-request cancellation, forwarded to the SDK so an abandoned
   * estimate stops retrying against a struggling engine instead of finishing its
   * full ladder. Supplied by {@link buildServer} from the MCP request `extra`.
   */
  signal?: AbortSignal;
  /**
   * The client identity from the MCP `initialize` handshake, as
   * `Server.getClientVersion()` returned it AT THIS CALL — supplied by
   * {@link buildServer} from inside the tools/call handler, never captured
   * earlier (see the note there). `undefined` is an ordinary, reachable answer
   * (nothing enforces initialize-first) and asserts nothing downstream.
   */
  clientInfo?: HandshakeClientInfo;
}

/**
 * Handle a `tools/call` request: reject an unknown tool as an `isError` result,
 * coerce the model-supplied arguments (a non-string `query` → `""`, a non-string
 * `model` → `undefined`), run the estimate, and map its `{ text, isError }` onto
 * MCP content. Extracted from the request handler so this dispatch/coercion can
 * be exercised without a live server; `deps` default to the real tool /
 * `process.env` / `process.cwd`, so the server's behavior is unchanged.
 */
export async function handleCallTool(
  request: CallToolRequest,
  deps: CallToolDeps = {},
): Promise<CallToolResult> {
  if (request.params.name !== TOOL_NAME) {
    return {
      content: [
        { type: "text", text: `Unknown tool: ${request.params.name}` },
      ],
      isError: true,
    };
  }
  const a = request.params.arguments ?? {};
  const query = typeof a.query === "string" ? a.query : "";
  const model = typeof a.model === "string" ? a.model : undefined;

  // The HOST's id for this call, carried in the request's `_meta`. It is not an
  // argument — the model cannot see it, set it, or influence it — and it is what
  // later lets a finished session's run be matched to its own transcript. Absent
  // on hosts that don't send it, which simply means that run is not reconcilable.
  const meta = request.params._meta as Record<string, unknown> | undefined;
  const rawToolUseId = meta?.[TOOL_USE_ID_META];
  const toolUseId = typeof rawToolUseId === "string" ? rawToolUseId : undefined;

  const result = await (deps.runEstimate ?? runEstimateTool)({
    query,
    model,
    env: deps.env ?? process.env,
    cwd: (deps.cwd ?? (() => process.cwd()))(),
    signal: deps.signal,
    toolUseId,
    clientInfo: deps.clientInfo,
  });
  return {
    content: [{ type: "text", text: result.text }],
    isError: result.isError,
  };
}

/** Injectable dependencies for {@link buildServer} (tests). */
export interface BuildServerDeps {
  /** Override the estimate tool (tests); defaults to {@link runEstimateTool}. */
  runEstimate?: typeof runEstimateTool;
}

/**
 * Build the MCP server with the single model-invokable `estimate` tool.
 *
 * Deliberately uses the low-level {@link Server} (not the high-level
 * `McpServer`) so the tool's input schema can be a plain JSON Schema and we
 * avoid taking a direct dependency on `zod`. There is intentionally no
 * actuals/report tool: token counts are never model-supplied.
 */
export function buildServer(deps: BuildServerDeps = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Forward the host's per-request cancellation (`extra.signal`) so an abandoned
  // estimate stops retrying against a struggling engine (sheds load in an outage)
  // rather than finishing its full ~5 min ladder for a result no one will read.
  //
  // The handshake identity is read HERE, inside the tools/call handler, at call
  // time — never at `oninitialized` (notification dispatch is one microtask hop
  // where request dispatch is two, so a client that pipelines `initialize` +
  // `notifications/initialized` into a single chunk fires that callback BEFORE
  // the identity is assigned) and never cached (a second `initialize` on a live
  // connection overwrites it). The SDK types it `Implementation | undefined`
  // and nothing enforces initialize-first, so `undefined` is an ordinary answer
  // that the tool treats as *unknown* — it asserts nothing.
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    handleCallTool(request, {
      signal: extra.signal,
      clientInfo: server.getClientVersion(),
      ...(deps.runEstimate !== undefined
        ? { runEstimate: deps.runEstimate }
        : {}),
    }),
  );

  return server;
}

/**
 * Seams for {@link runStdioServer} (tests only). `connect` defaults to wiring the
 * real stdio transport; `stderr` defaults to the process stream. Injecting a
 * no-op `connect` lets a test assert the readiness banner lands on STDERR without
 * standing up a real stdio transport (which would consume process stdin/stdout).
 */
export interface RunStdioServerDeps {
  connect?: (server: Server) => Promise<void>;
  stderr?: { write(s: string): void };
}

export async function runStdioServer(deps: RunStdioServerDeps = {}): Promise<void> {
  const server = buildServer();
  const connect =
    deps.connect ??
    (async (s: Server) => {
      await s.connect(new StdioServerTransport());
    });
  await connect(server);
  // One-line readiness banner on STDERR (stdout is the JSON-RPC channel). Without
  // it a bare `npx -y @budgetary/mcp` gives no sign of life — indistinguishable
  // from a hang — even though it is correctly waiting for a client on stdin. The
  // key TIER rides on the banner so free-vs-paid is visible where spending starts,
  // not only in `doctor` — never the key value, only its documented prefix.
  (deps.stderr ?? process.stderr).write(
    `Budgetary MCP server v${SERVER_VERSION} ready (stdio); ${keyTierBanner()}.\n`,
  );
  // The transport keeps the process alive while stdin is open; do not exit.
}

/**
 * A non-secret one-liner for the readiness banner describing the configured key's
 * TIER (never the value). Best-effort: any resolution fault degrades to a neutral
 * note rather than crashing server startup.
 */
function keyTierBanner(): string {
  try {
    const diag = configDiagnostics(process.env);
    if (diag.source === "none") return "no API key configured";
    if (diag.source === "unreadable") return "API key config unreadable";
    if (diag.keyPrefix === "bg_live_") return "key: bg_live_ (paid)";
    if (diag.keyPrefix === "bg_test_") return "key: bg_test_ (free)";
    return "key: unrecognized prefix";
  } catch {
    return "key: (unknown)";
  }
}

/** One-line-per-form usage, printed for `--help` and an unknown subcommand. */
function usageText(): string {
  return [
    "Budgetary MCP — pre-flight token-spend estimates for coding tasks.",
    "",
    "Usage:",
    "  npx @budgetary/mcp                                run the MCP stdio server (no arguments)",
    "  npx @budgetary/mcp doctor                         check version, key, base URL + connectivity",
    "  npx @budgetary/mcp pending                        list estimates awaiting actuals (read-only)",
    "  npx @budgetary/mcp report-actual                  enter realized counts by hand",
    "  npx @budgetary/mcp report-actual --estimate-id ID close a specific (already-billed) estimate for free",
    "  npx @budgetary/mcp on-session-end                 actuals from a session-end payload on stdin (host hook)",
    "  npx @budgetary/mcp on-session-end --transcript P  actuals from a rollout/transcript file P",
    "                     [--success|--failed]           declare the outcome YOUR oracle measured;",
    "                                                    neither flag = not observed (nothing is sent)",
    "                     [--censoring C]                C: how the run ended, exactly one of",
    "                                                    natural | harness_watchdog | operative_cap | kill_switch",
    "                                                    (anything else is omitted, never an error)",
    "  npx @budgetary/mcp --version                      print the version and exit",
    "  npx @budgetary/mcp --help                         show this help and exit",
    "",
  ].join("\n");
}

/** Run the `doctor` self-check against the real environment (foreground CLI). */
async function runDoctorCli(): Promise<number> {
  return runDoctor({
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
  });
}

/**
 * Parse `report-actual` arguments: an optional `--estimate-id <id>` (the FREE
 * close for a billed estimate whose local pending row failed to write). A flag
 * with no value, or a flag-shaped value, yields `null` (fall back to the normal
 * newest-pending path) rather than swallowing the next token.
 */
export function parseReportActualArgs(rest: string[]): { estimateId: string | null } {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--estimate-id") {
      const v = rest[i + 1];
      if (v !== undefined && !v.startsWith("-")) return { estimateId: v };
    }
  }
  return { estimateId: null };
}

async function runReportActualCli(estimateId: string | null): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runManualActuals({
      env: process.env,
      cwd: process.cwd(),
      out: (line) => process.stdout.write(`${line}\n`),
      prompt: (question) => rl.question(question),
      ...(estimateId !== null ? { estimateId } : {}),
    });
  } finally {
    rl.close();
  }
}

export interface OnSessionEndArgs {
  transcript: string | null;
  /**
   * The outcome the invoking harness DECLARED (`--success` / `--failed`), or
   * `null` when neither flag was passed. `null` is an absence, not a value:
   * downstream it OMITS the field rather than defaulting it. Same shape as
   * {@link censoring} for the same reason — a caller that declared nothing
   * must not be recorded as having declared something.
   */
  success: boolean | null;
  /**
   * The RAW `--censoring <value>` declaration, or null when the flag was
   * absent. Syntactic only: the exact-match check against the four contract
   * categories happens downstream (`runRolloutActuals`), where an unrecognized
   * value is OMITTED from the body — never normalized, never an error. Consumed
   * ONLY by the `--transcript` form; the stdin hook path never reads it.
   */
  censoring: string | null;
  /** A usage error (e.g. `--transcript` with no path), or null. */
  error: string | null;
}

/**
 * Parse `on-session-end` arguments: an optional rollout/transcript file path
 * (via `--transcript`/`--rollout` or a bare positional), an optional outcome
 * flag (`--failed` / `--success`, **no default**), and an optional
 * `--censoring <value>` run-termination declaration. The counts are always
 * measured from the file; only success and censoring are caller-declared. A
 * `--transcript`/`--rollout` with no value (or a flag-shaped value like
 * `--failed`) is a usage ERROR — it must never be swallowed as the path, nor
 * fall through to the stdin hook path where the explicit request to submit a
 * file would silently do nothing.
 *
 * `--censoring` MUST be handled inside this loop: the loop silently ignores
 * unrecognised flags, and its bare-positional branch claims the first non-flag
 * token when no transcript is set yet — so an unhandled `--censoring natural`
 * would swallow `natural` as the transcript path. Its value token is consumed
 * even when it is not a valid category (validation is downstream and
 * fail-closed to omission); a flag-shaped or missing value simply leaves the
 * declaration null — an absent observation, never an error.
 *
 * ⚠️ `success` starts at `null`, NOT `true`. The flags are the one honest
 * producer of this field — a harness invoking this subcommand is declaring what
 * its own oracle measured — but a harness that passes neither flag declared
 * nothing, and initializing to `true` silently recorded every such invocation
 * as a success it never measured. Absence of a flag is now absence of a value.
 */
export function parseOnSessionEndArgs(rest: string[]): OnSessionEndArgs {
  let transcript: string | null = null;
  let success: boolean | null = null;
  let censoring: string | null = null;
  let error: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--transcript" || a === "--rollout") {
      const val = rest[i + 1];
      if (val === undefined || val.startsWith("-")) {
        error = `${a} requires a file path`;
      } else {
        transcript = val;
        i++;
      }
    } else if (a === "--censoring") {
      const val = rest[i + 1];
      if (val !== undefined && !val.startsWith("-")) {
        censoring = val;
        i++;
      }
    } else if (a === "--failed") {
      success = false;
    } else if (a === "--success") {
      success = true;
    } else if (!a.startsWith("-") && transcript === null) {
      transcript = a;
    }
  }
  return { transcript, success, censoring, error };
}

/**
 * Injectable I/O + runner seams for {@link runOnSessionEndCli} (tests). Each
 * defaults to the real process stream / env / runner, so the CLI's behavior is
 * unchanged. `runAuto` lets a test observe how a stdin payload is routed to the
 * auto-actuals path without a live store or network (that path is itself covered
 * by the `runAutoActuals` tests).
 */
export interface OnSessionEndDeps {
  stdin?: AsyncIterable<string>;
  stderr?: { write(s: string): void };
  env?: NodeJS.ProcessEnv;
  runAuto?: typeof runAutoActuals;
}

export async function runOnSessionEndCli(
  rest: string[],
  deps: OnSessionEndDeps = {},
): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const { transcript, success, censoring, error } = parseOnSessionEndArgs(rest);
  // Fail loud on a malformed foreground request rather than silently entering
  // the stdin hook path (where it would hang on a TTY or no-op on empty stdin).
  if (error !== null) {
    stderr.write(
      `Budgetary: ${error}.\n` +
        "  Usage: npx @budgetary/mcp on-session-end --transcript <path> [--success|--failed] [--censoring <category>]\n",
    );
    return 2;
  }
  // Foreground form: an explicit rollout/transcript file path. Reads real counts
  // from the file and reports what it did — the working Codex actuals path.
  // This is the ONLY form that consumes `--censoring`: the invoking harness is
  // the measuring instrument here. The hook form below never reads it — its
  // payload's `reason` describes how the SESSION ended, not how the run ended,
  // and a declaration aimed at a transcript submit must not leak onto a path
  // that observed nothing.
  if (transcript !== null) {
    try {
      return await runRolloutActuals({
        transcriptPath: transcript,
        // Conditional, exactly like `censoring`: no flag ⇒ no field on the
        // wire. A harness that measured an outcome says so and its value is
        // forwarded verbatim; one that did not stays silent.
        ...(success !== null ? { success } : {}),
        ...(censoring !== null ? { censoring } : {}),
        env,
        cwd: process.cwd(),
        out: (line) => process.stdout.write(`${line}\n`),
      });
    } catch (err) {
      // A foreground command must surface an unforeseen fault as a NON-zero exit
      // (an honest failure signal) with a clean message — never a raw stack, and
      // never the hook path's exit-0, which a caller would read as "submitted".
      // (Covers e.g. `process.cwd()` throwing when the cwd was unlinked.)
      stderr.write(
        `Budgetary: couldn't submit actuals from ${transcript} (${
          err instanceof Error ? err.message : String(err)
        }).\n`,
      );
      return 1;
    }
  }

  // An explicit --censoring declaration only has meaning on the --transcript
  // form. Reaching here with one almost always means a caller forgot
  // --transcript — but this is also the path a (miswired) SessionEnd hook
  // would take, and the hook's contract is to fail closed (exit 0), so a loud
  // usage error is not available. Say where the declaration went — nowhere —
  // rather than discarding it silently; the hook behavior is otherwise
  // unchanged, and the value still influences nothing (see the doc above).
  if (censoring !== null) {
    stderr.write(
      "Budgetary: --censoring only applies to the --transcript form; ignoring it here.\n",
    );
  }
  // Hook form: a host (e.g. Claude Code SessionEnd) pipes one JSON payload
  // envelope on stdin. Stays silent on success and fails closed (exit 0) so a
  // malformed payload never crashes the host. The accumulator is size-bounded so
  // an unbounded/hostile stdin cannot exhaust memory; over the cap it drops what
  // it read and fails closed, exactly like a malformed payload.
  let raw = "";
  let overflow = false;
  const absorb = (chunk: string): void => {
    if (overflow) return;
    raw += chunk;
    if (raw.length > MAX_STDIN_BYTES) {
      overflow = true;
      raw = ""; // release the buffer; nothing over-cap is trusted
    }
  };
  if (deps.stdin !== undefined) {
    for await (const chunk of deps.stdin) {
      absorb(chunk);
      if (overflow) break;
    }
  } else {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      absorb(chunk);
      if (overflow) break;
    }
  }
  if (overflow) {
    stderr.write(
      "Budgetary: the session-end payload on stdin exceeded the size limit; ignoring it.\n",
    );
    return 0;
  }
  let payload: SessionEndPayload | null = null;
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw) as SessionEndPayload;
    } catch {
      payload = null;
    }
  }
  // A non-empty stdin that isn't a JSON payload is almost always a raw rollout
  // piped in (`cat rollout.jsonl | … on-session-end`), which cannot work this
  // way. Point at the form that does, rather than silently doing nothing.
  if (payload === null && raw.trim().length > 0) {
    stderr.write(
      "Budgetary: couldn't read a session-end payload from stdin. To submit a " +
        "rollout/transcript file directly, run:\n" +
        "  npx @budgetary/mcp on-session-end --transcript <path>\n",
    );
    return 0;
  }
  // Last-resort guard: the hook's contract is to FAIL CLOSED (exit 0) so an
  // environmental fault never crashes the host with a raw stack. runAutoActuals
  // already degrades its own store/network faults, but any unforeseen throw here
  // must still exit 0 rather than escape.
  try {
    return await (deps.runAuto ?? runAutoActuals)({
      payload,
      env,
      cwd: process.cwd(),
      stderr,
    });
  } catch (err) {
    stderr.write(
      `Budgetary: the session-end hook hit an unexpected error and did nothing (${
        err instanceof Error ? err.message : String(err)
      }).\n`,
    );
    return 0;
  }
}

function runPendingCli(): number {
  return runPendingList({
    env: process.env,
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
  });
}

/**
 * CLI entry point. Subcommands:
 *   (none)                        → run the MCP stdio server (returns null: do not exit)
 *   doctor                        → self-check: version, key source, base URL, connectivity
 *   pending                       → list pending estimates awaiting actuals (read-only)
 *   report-actual                 → manual, human-entered actuals
 *   on-session-end                → auto actuals from a session-end payload on stdin (hook)
 *   on-session-end --transcript P → submit actuals from a rollout/transcript file P
 *   --version / --help            → print version / usage and exit
 *
 * ONLY a bare invocation (no arguments) starts the long-lived stdio server. Any
 * unrecognized token gets a real answer (usage on stderr, exit 2) instead of
 * silently falling through to the server, where the documented
 * `npx -y @budgetary/mcp` smoke test would look like a freeze.
 */
export async function main(argv: string[]): Promise<number | null> {
  const sub = argv[0];
  try {
    if (sub === undefined) {
      await runStdioServer();
      return null;
    }
    if (sub === "--version" || sub === "-v" || sub === "version") {
      process.stdout.write(`${SERVER_VERSION}\n`);
      return 0;
    }
    if (sub === "--help" || sub === "-h" || sub === "help") {
      process.stdout.write(usageText());
      return 0;
    }
    if (sub === "doctor") return await runDoctorCli();
    if (sub === "pending") return runPendingCli();
    if (sub === "report-actual") {
      return await runReportActualCli(parseReportActualArgs(argv.slice(1)).estimateId);
    }
    if (sub === "on-session-end") return await runOnSessionEndCli(argv.slice(1));
    // Unknown subcommand: fail loud, never start the server.
    process.stderr.write(`Budgetary: unknown subcommand "${sub}".\n\n${usageText()}`);
    return 2;
  } catch (err) {
    // Backstop so no subcommand ever exits on a raw stack. The session-end HOOK
    // must fail closed (exit 0) whatever happens; every other subcommand is
    // foreground, so a nonzero exit is the honest signal (never a raw trace).
    process.stderr.write(
      `Budgetary: unexpected error (${
        err instanceof Error ? err.message : String(err)
      }).\n`,
    );
    return sub === "on-session-end" ? 0 : 1;
  }
}
