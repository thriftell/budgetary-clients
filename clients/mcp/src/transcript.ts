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

export interface TranscriptUsage extends TranscriptTotals {
  /**
   * Per-step execution trace on the SAME per-turn, cache-read-excluded basis
   * as {@link TranscriptTotals}. Empty when the run used no tools (e.g. a pure
   * text answer). NOT yet cap-checked — pass through {@link capTrace} before
   * submission.
   */
  trace: TraceStep[];
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
 * Best-effort parse of a session transcript JSONL file into session-level token
 * totals AND (for Claude Code) a per-tool execution trace, both on one shared
 * basis.
 *
 * TWO DIALECTS, detected by content. A Codex rollout carries cumulative
 * `event_msg` → `token_count` events and is handled by {@link readCodexTotals}
 * (totals only, empty trace — the rollout attributes no tokens per tool). A
 * Claude Code transcript carries per-turn `message.usage` and is handled by the
 * per-turn parse below. A file that is neither yields `null` (fail-closed).
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

  // Codex rollout dialect (event_msg → token_count → cumulative total) is
  // detected by content and parsed to totals only: the rollout does not
  // attribute tokens per tool, so the trace is empty (never a fabricated
  // per-tool breakdown). A Claude Code transcript has no such events and falls
  // through to the per-turn parse below.
  const codex = readCodexTotals(raw);
  if (codex !== null) {
    return { tokensIn: codex.tokensIn, tokensOut: codex.tokensOut, trace: [] };
  }

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
  for (const key of order) {
    const turn = turns.get(key)!;
    tokensIn += turn.tokensIn;
    tokensOut += turn.tokensOut;
    appendTurnSteps(trace, turn, results, includeTarget);
  }

  return { tokensIn, tokensOut, trace };
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

function toFiniteNonNeg(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

// ---------------------------------------------------------------------------
// Codex rollout dialect — the SECOND transcript shape the runtime parses.
//
// Claude Code writes per-turn `message.usage`; Codex (codex-rs) writes
// cumulative `event_msg` → `token_count` events whose final `total_token_usage`
// is the whole-session running total. Ported verbatim from the verified
// reference parser in clients/codex/src/transcript.ts (kept in sync there). Two
// facts drive it:
//   1. `total_token_usage` is CUMULATIVE, so we keep the LAST such record rather
//      than summing lines (summing would multiply spend by the event count).
//      `info` is `null` on some events (e.g. the first) — those are skipped.
//   2. Codex/OpenAI `input_tokens` INCLUDES cached input — the opposite of the
//      Anthropic basis — so we subtract `cached_input_tokens` (or the API-shaped
//      `input_tokens_details.cached_tokens`) to land on the same cache-read-
//      EXCLUDED basis the realized total and the Claude Code path use.
//      `output_tokens` already includes reasoning and is used as-is.
// ---------------------------------------------------------------------------

/**
 * Scan an already-read rollout for the FINAL cumulative `token_count` total on
 * the cache-excluded basis, or `null` when the file carries no such event —
 * i.e. it is not a Codex rollout, and the Claude Code path handles it instead.
 */
function readCodexTotals(raw: string): TranscriptTotals | null {
  let latest: TranscriptTotals | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const totals = codexTokenCountTotals(parsed as Record<string, unknown>);
    if (totals !== null) latest = totals;
  }
  return latest;
}

/**
 * Extract cache-excluded totals from a `token_count` event's cumulative
 * `total_token_usage`, or `null` when the line is not such an event (or its
 * `info` is `null`). Only the strict, confirmed shape is accepted.
 */
function codexTokenCountTotals(
  obj: Record<string, unknown>,
): TranscriptTotals | null {
  if (obj.type !== "event_msg") return null;
  const payload = obj.payload;
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "token_count") return null;
  const info = p.info;
  if (info === null || typeof info !== "object") return null;
  const usage = (info as Record<string, unknown>).total_token_usage;
  if (usage === null || typeof usage !== "object") return null;
  return codexUsageTotals(usage as Record<string, unknown>);
}

function codexUsageTotals(u: Record<string, unknown>): TranscriptTotals | null {
  const input = toFiniteNonNeg(u.input_tokens);
  const output = toFiniteNonNeg(u.output_tokens);
  if (input === null && output === null) return null;
  // input_tokens INCLUDES cached input → subtract to reach the cache-excluded
  // basis. Clamp at 0 so a malformed record can never yield a negative count.
  const cached = toFiniteNonNeg(codexCachedInputTokens(u)) ?? 0;
  const tokensIn = Math.max(0, (input ?? 0) - cached);
  return { tokensIn, tokensOut: output ?? 0 };
}

/** The cached-input figure, from either the rollout field or the API-shaped nesting. */
function codexCachedInputTokens(u: Record<string, unknown>): unknown {
  if (u.cached_input_tokens !== undefined) return u.cached_input_tokens;
  const details = u.input_tokens_details;
  if (details !== null && typeof details === "object") {
    return (details as Record<string, unknown>).cached_tokens;
  }
  return undefined;
}
