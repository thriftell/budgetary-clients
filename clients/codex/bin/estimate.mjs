#!/usr/bin/env node
// Thin CLI shim. Compiled implementation lives in ../dist/commands/estimate.js.
import { runEstimate } from "../dist/commands/estimate.js";

const argv = process.argv.slice(2);
const sepIndex = argv.indexOf("--");
const queryArgs = sepIndex >= 0 ? argv.slice(sepIndex + 1) : argv;
const query = queryArgs.join(" ").trim();

const exit = await runEstimate({
  query,
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(exit);
