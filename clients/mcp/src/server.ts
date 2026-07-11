import { readFileSync } from "node:fs";
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
import { runEstimateTool } from "./tools/estimate.js";

const SERVER_NAME = "budgetary";

/**
 * Upper bound on the session-end JSON envelope read from stdin. The real payload
 * is a small object; a larger stdin is hostile or a mistaken pipe, so the read is
 * bounded to avoid memory exhaustion and then fails closed (exit 0).
 */
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

/**
 * The handshake version, read from the package's own package.json so it always
 * matches the published `@budgetary/mcp` rather than drifting from a hard-coded
 * literal. `src/server.ts` and `dist/server.js` are both one level below the
 * package root, so `../package.json` resolves in both. Falls back to `0.0.0` if
 * it can't be read (never throws at import time).
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

/** The one and only model-invokable tool name. */
export const TOOL_NAME = "estimate";

const ESTIMATE_TOOL: Tool = {
  name: TOOL_NAME,
  title: "Budgetary: estimate token spend",
  description:
    "Return a pre-flight, probabilistic token-spend estimate for a coding " +
    "task before you run it, and store it so the realized cost can be " +
    "recorded afterward. Call this with the user's task described in natural " +
    "language. Returns a token range (p10–p90), a scenario label, and a " +
    "confidence score. This tool only estimates and records — it never " +
    "reports how many tokens a run actually used.",
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

  const result = await (deps.runEstimate ?? runEstimateTool)({
    query,
    model,
    env: deps.env ?? process.env,
    cwd: (deps.cwd ?? (() => process.cwd()))(),
  });
  return {
    content: [{ type: "text", text: result.text }],
    isError: result.isError,
  };
}

/**
 * Build the MCP server with the single model-invokable `estimate` tool.
 *
 * Deliberately uses the low-level {@link Server} (not the high-level
 * `McpServer`) so the tool's input schema can be a plain JSON Schema and we
 * avoid taking a direct dependency on `zod`. There is intentionally no
 * actuals/report tool: token counts are never model-supplied.
 */
export function buildServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    handleCallTool(request, {}),
  );

  return server;
}

async function runStdioServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the process alive while stdin is open; do not exit.
}

async function runReportActualCli(): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runManualActuals({
      env: process.env,
      cwd: process.cwd(),
      out: (line) => process.stdout.write(`${line}\n`),
      prompt: (question) => rl.question(question),
    });
  } finally {
    rl.close();
  }
}

export interface OnSessionEndArgs {
  transcript: string | null;
  success: boolean;
  /** A usage error (e.g. `--transcript` with no path), or null. */
  error: string | null;
}

/**
 * Parse `on-session-end` arguments: an optional rollout/transcript file path
 * (via `--transcript`/`--rollout` or a bare positional) and a success flag
 * (`--failed` / `--success`, default success). The counts are always measured
 * from the file; only success is caller-declared. A `--transcript`/`--rollout`
 * with no value (or a flag-shaped value like `--failed`) is a usage ERROR — it
 * must never be swallowed as the path, nor fall through to the stdin hook path
 * where the explicit request to submit a file would silently do nothing.
 */
export function parseOnSessionEndArgs(rest: string[]): OnSessionEndArgs {
  let transcript: string | null = null;
  let success = true;
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
    } else if (a === "--failed") {
      success = false;
    } else if (a === "--success") {
      success = true;
    } else if (!a.startsWith("-") && transcript === null) {
      transcript = a;
    }
  }
  return { transcript, success, error };
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
  const { transcript, success, error } = parseOnSessionEndArgs(rest);
  // Fail loud on a malformed foreground request rather than silently entering
  // the stdin hook path (where it would hang on a TTY or no-op on empty stdin).
  if (error !== null) {
    stderr.write(
      `Budgetary: ${error}.\n` +
        "  Usage: npx @budgetary/mcp on-session-end --transcript <path> [--failed]\n",
    );
    return 2;
  }
  // Foreground form: an explicit rollout/transcript file path. Reads real counts
  // from the file and reports what it did — the working Codex actuals path.
  if (transcript !== null) {
    return runRolloutActuals({
      transcriptPath: transcript,
      success,
      env,
      cwd: process.cwd(),
      out: (line) => process.stdout.write(`${line}\n`),
    });
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
 *   pending                       → list pending estimates awaiting actuals (read-only)
 *   report-actual                 → manual, human-entered actuals
 *   on-session-end                → auto actuals from a session-end payload on stdin (hook)
 *   on-session-end --transcript P → submit actuals from a rollout/transcript file P
 */
export async function main(argv: string[]): Promise<number | null> {
  const sub = argv[0];
  try {
    if (sub === "pending") return runPendingCli();
    if (sub === "report-actual") return await runReportActualCli();
    if (sub === "on-session-end") return await runOnSessionEndCli(argv.slice(1));
    await runStdioServer();
    return null;
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
