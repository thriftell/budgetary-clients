import { createInterface } from "node:readline/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  runAutoActuals,
  runManualActuals,
  runRolloutActuals,
  type SessionEndPayload,
} from "./actuals.js";
import { runEstimateTool } from "./tools/estimate.js";

const SERVER_NAME = "budgetary";
const SERVER_VERSION = "0.0.0";

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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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

    const result = await runEstimateTool({
      query,
      model,
      env: process.env,
      cwd: process.cwd(),
    });
    return {
      content: [{ type: "text", text: result.text }],
      isError: result.isError,
    };
  });

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

async function runOnSessionEndCli(rest: string[]): Promise<number> {
  const { transcript, success, error } = parseOnSessionEndArgs(rest);
  // Fail loud on a malformed foreground request rather than silently entering
  // the stdin hook path (where it would hang on a TTY or no-op on empty stdin).
  if (error !== null) {
    process.stderr.write(
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
      env: process.env,
      cwd: process.cwd(),
      out: (line) => process.stdout.write(`${line}\n`),
    });
  }

  // Hook form: a host (e.g. Claude Code SessionEnd) pipes one JSON payload
  // envelope on stdin. Stays silent on success and fails closed (exit 0) so a
  // malformed payload never crashes the host.
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
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
    process.stderr.write(
      "Budgetary: couldn't read a session-end payload from stdin. To submit a " +
        "rollout/transcript file directly, run:\n" +
        "  npx @budgetary/mcp on-session-end --transcript <path>\n",
    );
    return 0;
  }
  return runAutoActuals({
    payload,
    env: process.env,
    cwd: process.cwd(),
    stderr: process.stderr,
  });
}

/**
 * CLI entry point. Subcommands:
 *   (none)                        → run the MCP stdio server (returns null: do not exit)
 *   report-actual                 → manual, human-entered actuals
 *   on-session-end                → auto actuals from a session-end payload on stdin (hook)
 *   on-session-end --transcript P → submit actuals from a rollout/transcript file P
 */
export async function main(argv: string[]): Promise<number | null> {
  const sub = argv[0];
  if (sub === "report-actual") return runReportActualCli();
  if (sub === "on-session-end") return runOnSessionEndCli(argv.slice(1));
  await runStdioServer();
  return null;
}
