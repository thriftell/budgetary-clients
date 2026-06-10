#!/usr/bin/env node
// Thin launcher. Compiled implementation lives in ../dist/server.js.
//
//   npx @budgetary/mcp                  → run the MCP stdio server
//   npx @budgetary/mcp report-actual    → enter realized counts by hand
//   npx @budgetary/mcp on-session-end   → submit actuals from a transcript (stdin JSON)
import { main } from "../dist/server.js";

const code = await main(process.argv.slice(2));
// `null` means the stdio server is running; keep the process alive until stdin closes.
if (typeof code === "number") process.exit(code);
