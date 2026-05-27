#!/usr/bin/env node
// Thin CLI shim. Compiled implementation lives in ../dist/hooks/on_session_end.js.
import { runOnSessionEnd } from "../dist/hooks/on_session_end.js";

let payload = null;
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
if (raw.trim().length > 0) {
  try {
    payload = JSON.parse(raw);
  } catch {
    // Claude Code is expected to send JSON on stdin; if not, fall through with null
    // and let the handler decide whether there's anything to do.
  }
}

const exit = await runOnSessionEnd({
  payload,
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(exit);
