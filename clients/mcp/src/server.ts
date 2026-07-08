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

async function runOnSessionEndCli(): Promise<number> {
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
  return runAutoActuals({
    payload,
    env: process.env,
    cwd: process.cwd(),
    stderr: process.stderr,
  });
}

/**
 * CLI entry point. Subcommands:
 *   (none)          → run the MCP stdio server (returns null: do not exit)
 *   report-actual   → manual, human-entered actuals
 *   on-session-end  → auto actuals from a session transcript (reads stdin JSON)
 */
export async function main(argv: string[]): Promise<number | null> {
  const sub = argv[0];
  if (sub === "report-actual") return runReportActualCli();
  if (sub === "on-session-end") return runOnSessionEndCli();
  await runStdioServer();
  return null;
}
