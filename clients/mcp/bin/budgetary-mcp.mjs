#!/usr/bin/env node
// Thin launcher. Compiled implementation lives in ../dist/server.js.
//
//   npx @budgetary/mcp                                → run the MCP stdio server
//   npx @budgetary/mcp report-actual                  → enter realized counts by hand
//   npx @budgetary/mcp on-session-end                 → actuals from a session-end payload on stdin (host hook)
//   npx @budgetary/mcp on-session-end --transcript P  → actuals from a rollout/transcript file P
import { main } from "../dist/server.js";

const code = await main(process.argv.slice(2));
// `null` means the stdio server is running; keep the process alive until stdin closes.
if (typeof code === "number") process.exit(code);
