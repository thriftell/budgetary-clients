import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { ActualsTraceStep } from "@budgetary/sdk";

export interface TranscriptTotals {
  tokensIn: number;
  tokensOut: number;
}

/**
 * One measured execution step forwarded to `/v1/actuals` as the additive
 * `trace`. The shape is the wire contract's {@link ActualsTraceStep}: a raw
 * host tool name plus the real token count attributed to it. The client never
 * labels a phase or a verdict — it only reports what it measured; the server
 * classifies.
 */
export type TraceStep = ActualsTraceStep;

/**
 * Discrete, content-free change accounting for a session (0023c). Two MEASURED
 * integers — nothing else (no path, digest, diff, or change text) is implied:
 *   - `produced` — successful file-mutating tool calls this session
 *     ({@link MUTATE_TOOLS}: `Edit`/`Write`/`MultiEdit`), counted as **discrete
 *     events, not lines**.
 *   - `accepted` — of those, how many were NOT superseded by a later successful
 *     mutate to the SAME file within the session (the conservative within-session
 *     survival proxy — see {@link countChanges}). Always `<= produced`.
 * Both are measured from observed transcript events, never model-supplied.
 */
export interface ChangeCounts {
  produced: number;
  accepted: number;
}

export interface TranscriptUsage extends TranscriptTotals {
  /**
   * Per-step execution trace on the SAME per-turn, cache-read-excluded basis
   * as {@link TranscriptTotals}. Empty when the run used no tools (e.g. a pure
   * text answer). NOT yet cap-checked — pass through {@link capTrace} before
   * submission.
   */
  trace: TraceStep[];
  /**
   * Discrete file-change accounting for the session (0023c). ALWAYS measured
   * when the parse succeeds (a run with no edits is an honest `{0, 0}`); the
   * auto path forwards it additively unless the operator opts out of trace
   * detail. Independent of the trace and of {@link ReadUsageOptions.target}:
   * these are counts, so there is nothing to redact.
   */
  changes: ChangeCounts;
  /**
   * RAW local paths of the produced `.py` artifacts (successful mutate-family
   * targets) — the surface the structural-hallucination resolver reads (0023e).
   *
   * LOCAL-ONLY: unlike every other field on this object these are unredacted
   * paths, present ONLY so the caller can read the files locally and feed them
   * to the static resolver. They are NEVER forwarded — the auto path passes them
   * to {@link resolveHallucinations} (in `hallucination.ts`) and forwards only
   * the two resulting integer counts. No path, name, or content leaves the
   * machine. Distinct (deduped by path); order is not meaningful.
   */
  pythonArtifacts: string[];
}

/**
 * Server cap (0019a): an over-cap or malformed `trace` is dropped without
 * failing the actuals call, so the client may stay optimistic while never
 * shipping more than this. Mirrored here so we drop locally too.
 */
export const TRACE_MAX_STEPS = 512;
export const TRACE_MAX_BYTES = 16 * 1024;

export interface ReadUsageOptions {
  /**
   * Whether to attach the redacted {@link ActualsTraceStep.target} descriptor to
   * each step. Defaults to `true`. The privacy opt-out passes `false`, which
   * suppresses `target` entirely — the trace degrades to `{ tool, tokens, kind? }`
   * plus the leak-free `ok` flag, and the realized total is untouched. `ok` is
   * never gated by this: it carries no path, argument, or command.
   */
  target?: boolean;
}

/**
 * Best-effort parse of a Claude Code transcript JSONL file into session-level
 * token totals AND a per-tool execution trace, both on one shared basis.
 *
 * THE GRANULARITY FACT (verified against real Claude Code transcripts): token
 * `usage` is reported **per turn** (per assistant `message.id` / `requestId`),
 * never per individual tool call. The current Claude Code transcript writes one
 * JSONL line per *content block* (thinking / text / each `tool_use`), and every
 * one of those lines repeats the SAME turn-level `usage` object. So:
 *   - Totals dedupe by `message.id` — summing every line would multiply the
 *     real spend by the number of content blocks per turn (≈3–4×).
 *   - A turn's measured tokens cannot be split per tool from the data. A turn
 *     with one tool yields one step; a turn with N tools splits its measured
 *     tokens evenly across them, each flagged `kind: "turn-split"` — an honest
 *     measurement-granularity approximation, not fabricated per-tool precision.
 *
 * Token basis is `input_tokens + output_tokens`. `cache_read_input_tokens` is
 * deliberately EXCLUDED — the Anthropic usage object's `input_tokens` already
 * omits cache reads, so we neither add nor re-subtract them. This is the exact
 * basis the realized total has always used; the trace must not diverge from it.
 *
 * Returning `null` is load-bearing: callers MUST NOT submit actuals without
 * real token counts, and MUST NOT invent trace steps.
 *
 * Each tool step additionally carries two RAW MEASUREMENTS when the transcript
 * exposes them (still behavior, never classification — the server labels):
 *   - `target`: a REDACTED descriptor of what the step acted on (program name +
 *     non-reversible digest for shell steps; a bare path digest for file tools).
 *     Suppressed wholesale by {@link ReadUsageOptions.target} = `false`.
 *   - `ok`: the measured outcome, `!is_error` of the matching `tool_result`.
 *     Outcomes arrive on a LATER user line than the `tool_use`, so they are
 *     collected across the whole file before the trace is assembled.
 * Either field is omitted when it cannot be read reliably — the step still
 * forwards with `tool` + `tokens` (exactly the prior behavior). Nothing here is
 * model-supplied.
 *
 * The result also carries {@link ChangeCounts} — two content-free integers
 * (produced/accepted file changes) measured off the same mutate-family events;
 * see {@link countChanges}. These are counts only: no path, diff, or content.
 */
export function readTranscriptUsage(
  path: string,
  options: ReadUsageOptions = {},
): TranscriptUsage | null {
  const includeTarget = options.target !== false;
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;

  // Group lines into turns. A turn is keyed by its assistant `message.id` so
  // the repeated per-content-block usage is counted once. Lines that carry
  // usage but no `message.id` (older single-line transcripts, synthetic
  // fixtures) each form their own turn — they were never over-counted, so this
  // leaves their totals unchanged.
  const turns = new Map<string, Turn>();
  const order: string[] = [];
  // Outcome map: tool_use id -> is_error, harvested from user-message
  // `tool_result` blocks. Only boolean `is_error` is recorded; an absent flag
  // (the host writes none on a successful file read/edit) leaves the step with
  // no `ok` rather than a fabricated one.
  const results = new Map<string, boolean>();
  // Every tool_use id that has ANY `tool_result` block, regardless of `is_error`.
  // A successful file edit's result carries no `is_error` (verified against real
  // transcripts), so it is absent from `results` but present here — this set is
  // how {@link mutateSucceeded} tells a landed edit from a phantom with no result.
  const resultIds = new Set<string>();
  let lineNo = 0;

  for (const line of raw.split("\n")) {
    lineNo += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;

    // Tool outcomes ride on user lines (no usage); harvest them first.
    for (const [id, isError] of toolResultsIn(obj)) results.set(id, isError);
    for (const id of toolResultIdsIn(obj)) resultIds.add(id);

    const usage = findUsage(obj);
    if (!usage) continue;
    const inT = toFiniteNonNeg(usage.input_tokens);
    const outT = toFiniteNonNeg(usage.output_tokens);
    if (inT === null && outT === null) continue;

    const key = messageId(obj) ?? `__line_${lineNo}`;
    let turn = turns.get(key);
    if (!turn) {
      // First line of this turn carries the canonical (and, in practice,
      // invariant) usage. Subsequent lines repeat it; we never re-add.
      turn = { tokensIn: inT ?? 0, tokensOut: outT ?? 0, tools: [] };
      turns.set(key, turn);
      order.push(key);
    }
    // A tool_use may appear on this line whether or not it opened the turn.
    for (const use of toolUsesIn(obj)) turn.tools.push(use);
  }

  if (order.length === 0) return null;

  let tokensIn = 0;
  let tokensOut = 0;
  const trace: TraceStep[] = [];
  const tools: ToolUse[] = [];
  for (const key of order) {
    const turn = turns.get(key)!;
    tokensIn += turn.tokensIn;
    tokensOut += turn.tokensOut;
    appendTurnSteps(trace, turn, results, includeTarget);
    // Same mutate-family stream the trace parses — we only COUNT it here.
    for (const use of turn.tools) tools.push(use);
  }

  const changes = countChanges(tools, results, resultIds);
  const pythonArtifacts = collectPythonArtifacts(tools, results, resultIds);
  return { tokensIn, tokensOut, trace, changes, pythonArtifacts };
}

/**
 * Back-compat thin wrapper: realized token totals only, on the corrected
 * per-turn basis. The auto and manual actuals paths use this when they need
 * just the counts.
 */
export function readTranscriptTotals(path: string): TranscriptTotals | null {
  // Totals-only: skip target redaction, whose result this caller discards.
  const usage = readTranscriptUsage(path, { target: false });
  if (usage === null) return null;
  return { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
}

/**
 * Apply the server-mirrored cap and fail closed. Returns the trace unchanged
 * when it is non-empty and within both caps; otherwise `null`, meaning "submit
 * the total with no trace". Never throws, never trims to fit (a partial trace
 * would misrepresent the run), never invents steps.
 */
export function capTrace(trace: TraceStep[]): TraceStep[] | null {
  if (trace.length === 0) return null;
  if (trace.length > TRACE_MAX_STEPS) return null;
  if (Buffer.byteLength(JSON.stringify(trace), "utf8") > TRACE_MAX_BYTES) {
    return null;
  }
  return trace;
}

// ---------------------------------------------------------------------------
// Target redaction — utility WITHOUT leakage
//
// `target` must give the server (a) the program name IN THE CLEAR (so it can
// recognize a test/build runner — Claude Code runs them through the generic
// `Bash` tool) and (b) a STABLE EQUALITY KEY (so the same failed operation run
// twice is detectable as a retry), while leaking nothing else. A raw `Bash`
// line can hold secrets, tokens, absolute paths, and arguments, so the raw
// command/path is NEVER forwarded — only a redacted descriptor:
//
//   • shell step  → "<program> [<subcommand>] <digest>" (e.g. "pytest a1b2…",
//     "go test a1b2…", "npx jest a1b2…"). ONLY two things may ever appear in the
//     clear: the program name (the leading token of the FIRST logical line, after
//     a quote-safe `VAR=val` / `cd …&&` / `source …&&` peel, basenamed), and a
//     second token drawn from a FIXED keyword allowlist — either a known driver's
//     subcommand ({@link DRIVER_SUBCOMMANDS}, e.g. `go test`) or, for a package
//     runner (`npx`/`bunx`/`pnpm dlx`/`yarn dlx`), the runner tool it executes
//     ({@link RUNNER_TOOLS}, e.g. `npx jest`). Everything else — arguments,
//     file/target names, paths, redirects, later lines, heredoc bodies, the whole
//     chain — lives ONLY inside the non-reversible digest. When the program
//     cannot be identified safely the whole target is omitted (fail closed).
//   • file tool   → bare path digest. The server classifies file tools by tool
//     name, so the target is purely a retry key; the path never appears.
//
// The digest is a truncated SHA-256 of the NORMALIZED input (trim + collapse
// whitespace), so the same operation hashes identically (stable retry key) and
// nothing about the input can be recovered from it.
//
// Leakage is the crux, so the cleartext is gated by ALLOWLISTS, not charsets: a
// charset (“looks like a word”) would still pass prose, branch names, script
// names, and many secret tokens. Membership in a fixed keyword set cannot.
// ---------------------------------------------------------------------------

/** Truncated, non-reversible SHA-256 — a stable equality key, never a payload. */
function shortDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/**
 * Drivers eligible for a two-token target (`go test`, `npm run`, `pip install`):
 * programs whose second token MAY be a subcommand. The second token is exposed
 * only when it is ALSO in {@link DRIVER_SUBCOMMANDS}, so a driver invoked with a
 * free-form argument instead (`node run.js`, `make deploy-prod`, `python app.py`)
 * never leaks that argument — it degrades to the program name alone.
 */
const KNOWN_DRIVERS = new Set([
  "go", "npm", "npx", "pnpm", "yarn", "cargo", "git", "pip", "pip3", "python",
  "python3", "dotnet", "mvn", "gradle", "bundle", "rake", "make", "docker",
  "kubectl", "node", "deno", "bun", "poetry", "uv", "composer", "gem", "ruby",
  "mix", "sbt", "bazel", "tox",
]);

/**
 * The ONLY tokens permitted in a target's cleartext second slot: a fixed
 * allowlist of generic build/test/package subcommand keywords (plus the common
 * `python -m` runner modules). Membership — not a charset — is the gate, so a
 * free-form script name, build target, package name, branch, or path can NEVER
 * reach the clear; it stays inside the digest. Anything not listed degrades the
 * target to the program name alone (safe, lossy).
 */
const DRIVER_SUBCOMMANDS = new Set([
  // build / test / quality verbs
  "test", "tests", "build", "run", "check", "lint", "fmt", "format", "vet",
  "typecheck", "compile", "bench", "cover", "coverage", "e2e", "unit",
  // package / project lifecycle verbs
  "install", "ci", "exec", "add", "update", "publish", "pack", "audit", "sync",
  // common `python -m` runner modules
  "pytest", "unittest", "mypy", "tox", "nox", "ruff", "pyright",
]);

/**
 * Package-runner tools (0019e) eligible for the cleartext second slot when they
 * run through a runner preamble (`npx`/`bunx`/`pnpm dlx`/`yarn dlx`). The tool
 * that actually executes (`jest`, `vitest`, …) is NOT a driver subcommand, so
 * without this it would redact to the bare program (`"npx <digest>"`) and the
 * server (0019c-2) would have no signal → `other`. Exposing the runner tool as
 * the second token gives the server exactly the same generic-shell second-token
 * signal it already classifies.
 *
 * Like every other cleartext slot this is a FIXED ALLOWLIST, never a charset: a
 * package name is precisely the free-form, possibly-private token that can leak,
 * so membership — not "looks like a word" — is the gate. A non-listed runner
 * (`npx my-private-cli`, `npx some-codegen`) stays inside the digest. Formatters
 * (`prettier`) are deliberately OUT: formatting is not verification.
 */
const RUNNER_TOOLS = new Set([
  "jest", "vitest", "mocha", "ava", "tap", "jasmine", "karma", "cypress",
  "playwright", "tsc", "eslint", "biome", "nyc", "c8",
]);

/**
 * For a package-runner preamble, return the effective runner program IFF it is
 * an allowlisted {@link RUNNER_TOOLS} member; otherwise `null` (not a runner
 * preamble, or a free-form/private package → it stays inside the digest). The
 * runner tool sits one token past the preamble:
 *   • `npx <tool>` / `bunx <tool>`           → token index 1
 *   • `pnpm dlx <tool>` / `yarn dlx <tool>`  → token index 2
 * Membership (not a charset) is the leak gate, exactly as DRIVER_SUBCOMMANDS.
 * `program` is already lowercased+basenamed; the runner token is matched
 * case-sensitively against the lowercase allowlist, mirroring the driver rule.
 */
function packageRunnerTool(program: string, tokens: string[]): string | null {
  let tool: string | undefined;
  if (program === "npx" || program === "bunx") {
    tool = tokens[1];
  } else if ((program === "pnpm" || program === "yarn") && tokens[1] === "dlx") {
    tool = tokens[2];
  } else {
    return null;
  }
  return tool !== undefined && RUNNER_TOOLS.has(tool) ? tool : null;
}

// A clean program name (no slash/space/`=`/quote) — only such a token is exposed
// in the clear as the program. Anything else fails closed (no target).
const SAFE_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** True when `token` holds an unbalanced quote — i.e. a value that continues
 * into the next whitespace-separated token (so its interior must not be read as
 * the program). */
function hasUnbalancedQuote(token: string): boolean {
  let dq = 0;
  let sq = 0;
  for (const ch of token) {
    if (ch === '"') dq += 1;
    else if (ch === "'") sq += 1;
  }
  return dq % 2 !== 0 || sq % 2 !== 0;
}

/**
 * Resolve the segment whose LEADING token names the program that actually ran,
 * working ONLY on the first logical line and never crossing a quote — so a
 * heredoc body, a quoted argument, or any later-line text can never be mistaken
 * for the program. Peels leading `VAR=val` assignments and `cd|source|. <arg>
 * &&|;|||` preambles, both same-line and quote-safe. Returns `null` (fail
 * closed) when a leading env value is a partial quoted string whose interior
 * would otherwise surface as the program.
 *
 * This is MEASUREMENT (which token is the program), not classification; the
 * peeled text (a secret value, an absolute path) is dropped here and survives
 * only inside the digest of the full command.
 */
function programSegment(command: string): string | null {
  // First logical line only — later lines (heredoc bodies, quoted prose) must be
  // unreachable when identifying the program.
  let s = command.replace(/\r/g, "").trim();
  const nl = s.indexOf("\n");
  if (nl !== -1) s = s.slice(0, nl).trim();

  for (let i = 0; i < 6; i++) {
    // One leading `KEY=value` assignment, quote-safely.
    const env = s.match(/^([A-Za-z_][A-Za-z0-9_]*=\S*)\s+(.*)$/);
    if (env) {
      // A quoted value with interior spaces would leave its tail as the next
      // token (the leak class) — refuse rather than tokenize into it.
      if (hasUnbalancedQuote(env[1]!)) return null;
      s = env[2]!;
      continue;
    }
    // One leading `cd|source|. <unquoted-arg> &&|;|||` preamble, same line only.
    const pre = s.match(/^(?:cd|source|\.)\s+[^\s'"]+\s*(?:&&|;|\|\|)\s*(.+)$/);
    if (pre && pre[1]!.trim().length > 0) {
      s = pre[1]!.trim();
      continue;
    }
    break;
  }
  return s;
}

/**
 * Redact a shell command to `"<program> [<subcommand>] <digest>"`, or `null`
 * when no program name can be exposed safely (fail closed). The digest covers
 * the WHOLE normalized command, so an identical re-run is an identical target.
 */
export function redactBashTarget(command: string): string | null {
  if (typeof command !== "string" || command.trim().length === 0) return null;
  const digest = shortDigest(command.trim().replace(/\s+/g, " "));
  const segment = programSegment(command);
  if (segment === null) return null;
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  let program = tokens[0]!;
  if (program.includes("/")) program = program.slice(program.lastIndexOf("/") + 1);
  if (!SAFE_PROGRAM.test(program)) return null;

  const parts = [program];
  const lower = program.toLowerCase();
  const runner = packageRunnerTool(lower, tokens);
  if ((lower === "python" || lower === "python3") && tokens[1] === "-m") {
    // `python -m pytest` — the module is the effective program. Expose it only
    // when it is an allowlisted runner keyword (never a private module name).
    if (tokens[2] && DRIVER_SUBCOMMANDS.has(tokens[2])) parts.push(tokens[2]);
  } else if (runner !== null) {
    // `npx jest` / `pnpm dlx playwright test` — the runner tool is the effective
    // program. Exposed only via the RUNNER_TOOLS allowlist, so a free-form/private
    // `npx <pkg>` degrades to the bare runner program (`"npx <digest>"`).
    parts.push(runner);
  } else if (
    KNOWN_DRIVERS.has(lower) &&
    tokens[1] &&
    DRIVER_SUBCOMMANDS.has(tokens[1])
  ) {
    parts.push(tokens[1]);
  }
  return `${parts.join(" ")} ${digest}`;
}

/** Redact a file path to a bare, non-reversible digest (a retry key only). */
export function redactFileTarget(path: string): string | null {
  if (typeof path !== "string" || path.trim().length === 0) return null;
  return shortDigest(path.trim());
}

/**
 * Derive the redacted `target` for one tool use, or `null` to omit it. Shell
 * steps redact `input.command`; any tool exposing a path (`file_path` /
 * `notebook_path` / `path`) gets a bare path digest; everything else has no
 * safe descriptor and is omitted (fail closed).
 */
export function redactTarget(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName === "Bash") {
    return typeof input.command === "string"
      ? redactBashTarget(input.command)
      : null;
  }
  const path = input.file_path ?? input.notebook_path ?? input.path;
  return typeof path === "string" ? redactFileTarget(path) : null;
}

// ---------------------------------------------------------------------------
// Change accounting (0023c) — two content-free integers, nothing else
//
// The client measures whether the run's spend converted into edits that stuck,
// so the server can report cost-per-accepted efficiency. It classifies NOTHING
// and forwards NOTHING but the two counts: no path, digest, diff, or change
// text ever leaves this section. Both are derived from the SAME mutate-family
// tool events the trace already parses — reused, not re-parsed.
//
//   • produced — successful file-mutating tool calls (discrete events, not lines)
//   • accepted — of those, the ones NOT superseded by a later successful mutate
//     to the same file within the session
//
// Survival heuristic — deliberately CONSERVATIVE (under-count, never over-count),
// because the client is content-blind (it has target identity + event order, not
// diffs): a produced change is "accepted" iff no later SUCCESSFUL mutate touched
// the same file this session. A later same-file edit decrements the earlier one —
// we cannot tell a revert from an unrelated hunk without content, so we refuse to
// claim the earlier change survived. Equivalently, accepted = the number of
// distinct files left with a surviving successful edit at session close.
//
// What this deliberately does NOT try to detect: a change undone by a DIFFERENT
// tool (`rm`, `git checkout`, `git stash`) is content-invisible from mutate
// events and is out of scope here; durable, cross-session persistence is measured
// server-side over time (0023b-2), never fabricated on the client.
// ---------------------------------------------------------------------------

/**
 * File-mutating tool family. A successful call to one of these is a discrete
 * "produced change". Claude Code emits `Edit`/`Write` today and historically
 * `MultiEdit`; read/search/shell tools are NOT here — they produce no tracked
 * file change. This is exactly the family the prompt names; membership, not a
 * heuristic, is the gate.
 */
const MUTATE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Whether a mutate `tool_use` is a CONFIRMED success. A file tool's successful
 * result carries no `is_error` (so it is absent from `results`), while a failure
 * carries `is_error: true`; a denied/failed call must not count as produced. So
 * success requires (a) a joinable id, (b) a `tool_result` actually present
 * ({@link resultIds}), and (c) that result not flagged an error. A mutate with
 * no id or no result is UNCONFIRMED — excluded from produced (conservative).
 */
function mutateSucceeded(
  use: ToolUse,
  results: Map<string, boolean>,
  resultIds: Set<string>,
): boolean {
  if (use.id === null) return false;
  if (!resultIds.has(use.id)) return false;
  return results.get(use.id) !== true;
}

/**
 * The content-free grouping key for a mutate's target file: the SAME
 * non-reversible path digest the trace uses ({@link redactFileTarget}). Two edits
 * to one file share a key; the raw path never leaves this module, and a (vanishing)
 * digest collision would merge two files → under-count acceptance, which is the
 * safe direction. `null` when no path can be read (then the change is produced
 * but never accepted — survival is undeterminable).
 */
function mutateTargetKey(input: Record<string, unknown>): string | null {
  const path = input.file_path ?? input.notebook_path ?? input.path;
  return typeof path === "string" ? redactFileTarget(path) : null;
}

/**
 * Count produced/accepted changes over a session's mutate events. Pure and
 * order-independent: `produced` is the number of confirmed-successful mutate
 * calls; `accepted` is the number of DISTINCT target files among them (each
 * distinct file contributes exactly its surviving last edit — earlier edits to
 * the same file are treated as superseded). A successful mutate whose target
 * can't be derived counts toward `produced` but never `accepted`. Guarantees
 * `0 <= accepted <= produced`. Returns only integers.
 */
export function countChanges(
  tools: ReadonlyArray<ToolUse>,
  results: Map<string, boolean>,
  resultIds: Set<string>,
): ChangeCounts {
  let produced = 0;
  const survivingTargets = new Set<string>();
  for (const use of tools) {
    if (!MUTATE_TOOLS.has(use.name)) continue;
    if (!mutateSucceeded(use, results, resultIds)) continue;
    produced += 1;
    const key = use.input !== null ? mutateTargetKey(use.input) : null;
    if (key !== null) survivingTargets.add(key);
  }
  return { produced, accepted: survivingTargets.size };
}

/**
 * The RAW target path of a mutate `tool_use`, or `null` when none can be read.
 * Unlike {@link mutateTargetKey} this returns the path IN THE CLEAR — used ONLY
 * by {@link collectPythonArtifacts} to hand local file paths to the static
 * resolver. The path never leaves the module boundary as anything but a resolved
 * count.
 */
function mutateTargetPath(input: Record<string, unknown>): string | null {
  const path = input.file_path ?? input.notebook_path ?? input.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

/**
 * Collect the DISTINCT raw `.py` file paths a session successfully produced
 * (0023e) — the surface the structural-hallucination resolver measures. Reuses
 * the SAME confirmed-success mutate detection as {@link countChanges}
 * ({@link MUTATE_TOOLS} + {@link mutateSucceeded}); a failed/denied/unconfirmed
 * edit contributes nothing. Only `.py` targets are kept (Python-first); paths are
 * deduped so repeated edits to one file yield one artifact.
 *
 * The returned strings are RAW local paths — a LOCAL-ONLY input for the resolver,
 * never forwarded. The caller reads these files on the machine and forwards only
 * the two integer counts the resolver returns. `existsSync`-at-close filtering is
 * done downstream (in the resolver), so a file deleted before session end drops
 * out there.
 */
export function collectPythonArtifacts(
  tools: ReadonlyArray<ToolUse>,
  results: Map<string, boolean>,
  resultIds: Set<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const use of tools) {
    if (!MUTATE_TOOLS.has(use.name)) continue;
    if (!mutateSucceeded(use, results, resultIds)) continue;
    if (use.input === null) continue;
    const path = mutateTargetPath(use.input);
    if (path === null || !path.endsWith(".py")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

interface ToolUse {
  name: string;
  /** `tool_use.id`, used to join the later `tool_result` outcome. */
  id: string | null;
  /** Raw `tool_use.input`, read only to derive the REDACTED target. */
  input: Record<string, unknown> | null;
}

interface Turn {
  tokensIn: number;
  tokensOut: number;
  tools: ToolUse[];
}

function appendTurnSteps(
  trace: TraceStep[],
  turn: Turn,
  results: Map<string, boolean>,
  includeTarget: boolean,
): void {
  const n = turn.tools.length;
  if (n === 0) return; // text/thinking-only turn → no tool step (still in totals)
  const turnTokens = turn.tokensIn + turn.tokensOut;
  // Token attribution is unchanged: one tool → the whole turn; many tools →
  // an even split with the integer remainder front-loaded so the steps sum back
  // to the turn total. `target`/`ok` are PER-TOOL facts (not split): each tool
  // has its own command/path and its own outcome.
  const base = Math.floor(turnTokens / n);
  let remainder = turnTokens - base * n;
  for (const use of turn.tools) {
    let tokens: number;
    if (n === 1) {
      tokens = turnTokens;
    } else {
      tokens = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
    const step: TraceStep = { tool: use.name, tokens };
    if (n > 1) step.kind = "turn-split";
    if (includeTarget && use.input !== null) {
      const target = redactTarget(use.name, use.input);
      if (target !== null) step.target = target;
    }
    if (use.id !== null) {
      const isError = results.get(use.id);
      if (typeof isError === "boolean") step.ok = !isError;
    }
    trace.push(step);
  }
}

interface Usage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

function findUsage(obj: Record<string, unknown>): Usage | null {
  if (obj.usage && typeof obj.usage === "object") {
    return obj.usage as Usage;
  }
  const message = obj.message;
  if (message && typeof message === "object") {
    const inner = (message as Record<string, unknown>).usage;
    if (inner && typeof inner === "object") return inner as Usage;
  }
  return null;
}

function messageId(obj: Record<string, unknown>): string | null {
  const message = obj.message;
  if (message && typeof message === "object") {
    const id = (message as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function toolUsesIn(obj: Record<string, unknown>): ToolUse[] {
  const message = obj.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const uses: ToolUse[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && typeof b.name === "string" && b.name.length > 0) {
      const input =
        b.input !== null && typeof b.input === "object" && !Array.isArray(b.input)
          ? (b.input as Record<string, unknown>)
          : null;
      uses.push({
        name: b.name,
        id: typeof b.id === "string" && b.id.length > 0 ? b.id : null,
        input,
      });
    }
  }
  return uses;
}

/**
 * Harvest `(tool_use_id, is_error)` pairs from a transcript line. Tool outcomes
 * arrive in user-message `tool_result` blocks, on a LATER line than the
 * `tool_use`. Only a BOOLEAN `is_error` is returned: the host writes `is_error`
 * on every shell result (true on failure, false on success) but omits it from a
 * successful file read/edit, so an absent flag must stay "unknown", not become a
 * fabricated success.
 */
function toolResultsIn(obj: Record<string, unknown>): Array<[string, boolean]> {
  const message = obj.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const out: Array<[string, boolean]> = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (
      b.type === "tool_result" &&
      typeof b.tool_use_id === "string" &&
      b.tool_use_id.length > 0 &&
      typeof b.is_error === "boolean"
    ) {
      out.push([b.tool_use_id, b.is_error]);
    }
  }
  return out;
}

/**
 * Harvest every `tool_use_id` that has ANY `tool_result` block on this line,
 * regardless of `is_error`. A successful file edit's result carries no
 * `is_error` (so {@link toolResultsIn} skips it), yet its presence is what
 * distinguishes a landed edit from a `tool_use` with no result at all — the
 * signal {@link mutateSucceeded} needs to confirm a produced change.
 */
function toolResultIdsIn(obj: Record<string, unknown>): string[] {
  const message = obj.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (
      b.type === "tool_result" &&
      typeof b.tool_use_id === "string" &&
      b.tool_use_id.length > 0
    ) {
      out.push(b.tool_use_id);
    }
  }
  return out;
}

function toFiniteNonNeg(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}
