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
 */
export function readTranscriptUsage(path: string): TranscriptUsage | null {
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
    for (const name of toolNamesIn(obj)) turn.tools.push(name);
  }

  if (order.length === 0) return null;

  let tokensIn = 0;
  let tokensOut = 0;
  const trace: TraceStep[] = [];
  for (const key of order) {
    const turn = turns.get(key)!;
    tokensIn += turn.tokensIn;
    tokensOut += turn.tokensOut;
    appendTurnSteps(trace, turn);
  }

  return { tokensIn, tokensOut, trace };
}

/**
 * Back-compat thin wrapper: realized token totals only, on the corrected
 * per-turn basis. The auto and manual actuals paths use this when they need
 * just the counts.
 */
export function readTranscriptTotals(path: string): TranscriptTotals | null {
  const usage = readTranscriptUsage(path);
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

interface Turn {
  tokensIn: number;
  tokensOut: number;
  tools: string[];
}

function appendTurnSteps(trace: TraceStep[], turn: Turn): void {
  const n = turn.tools.length;
  if (n === 0) return; // text/thinking-only turn → no tool step (still in totals)
  const turnTokens = turn.tokensIn + turn.tokensOut;
  if (n === 1) {
    trace.push({ tool: turn.tools[0]!, tokens: turnTokens });
    return;
  }
  // Multi-tool turn: usage is per-turn, so attribute it evenly. Front-load the
  // integer remainder so the steps sum back to the turn's measured tokens.
  const base = Math.floor(turnTokens / n);
  let remainder = turnTokens - base * n;
  for (const tool of turn.tools) {
    const tokens = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    trace.push({ tool, tokens, kind: "turn-split" });
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

function toolNamesIn(obj: Record<string, unknown>): string[] {
  const message = obj.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && typeof b.name === "string" && b.name.length > 0) {
      names.push(b.name);
    }
  }
  return names;
}

function toFiniteNonNeg(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}
