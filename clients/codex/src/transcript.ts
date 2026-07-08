// Reference parser for the Codex rollout `token_count` shape. The SHIPPED copy
// of this logic now lives in the published runtime at
// clients/mcp/src/transcript.ts (readCodexTotals), which `npx @budgetary/mcp
// on-session-end --transcript <path>` uses to close the loop on Codex. Keep the
// two in sync; this file remains the CI-tested reference for the (future) Codex
// Stop hook handler under src/hooks/.
//
// Codex's Stop hook payload, like Claude Code's SessionEnd, does not include
// session-level token totals — only `transcript_path` pointing at the rollout
// JSONL at `~/.codex/sessions/rollout-<ts>-<uuid>.jsonl`.
//
// The rollout records token usage as a CUMULATIVE running total on dedicated
// event lines (confirmed against real `codex-rs` rollouts):
//
//   {"type":"event_msg","payload":{"type":"token_count","info":{
//      "total_token_usage":{"input_tokens":9433942,"cached_input_tokens":8803968,
//        "output_tokens":28055,"reasoning_output_tokens":20160,"total_tokens":9461997},
//      "last_token_usage":{...},"model_context_window":272000}}}
//
// Two facts drive the parser:
//   1. `total_token_usage` is CUMULATIVE for the whole session, so we take the
//      FINAL such record rather than summing lines (summing would multiply the
//      real spend by the number of token_count events). `info` is `null` on the
//      first event and possibly others — those records are skipped.
//   2. Codex/OpenAI `input_tokens` INCLUDES cached input, the opposite of the
//      Anthropic basis. We subtract `cached_input_tokens` (or
//      `input_tokens_details.cached_tokens`) to land on the same
//      cache-read-EXCLUDED basis the server calibrates on. `output_tokens`
//      already includes `reasoning_output_tokens`, so it is used as-is.
import { existsSync, readFileSync } from "node:fs";

export interface TranscriptTotals {
  tokensIn: number;
  tokensOut: number;
}

/**
 * Best-effort parse of a Codex rollout JSONL transcript to total session-level
 * input / output tokens on the cache-read-excluded basis. Returns the FINAL
 * cumulative `token_count` total, or `null` if no such record is present — a
 * shape we don't recognize fails closed rather than emitting a wrong count.
 *
 * Returning `null` is load-bearing: callers MUST NOT submit actuals without
 * real token counts.
 */
export function readTranscriptTotals(path: string): TranscriptTotals | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;

  // Cumulative: keep the LAST record that carries real totals.
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
    const totals = tokenCountTotals(parsed as Record<string, unknown>);
    if (totals !== null) latest = totals;
  }

  return latest;
}

/**
 * Extract the cache-excluded totals from a `token_count` event's cumulative
 * `total_token_usage`, or `null` when the line is not such an event (or its
 * `info` is `null`). Only the strict, confirmed shape is accepted.
 */
function tokenCountTotals(
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
  return usageTotals(usage as Record<string, unknown>);
}

function usageTotals(u: Record<string, unknown>): TranscriptTotals | null {
  const input = toFiniteNonNeg(u.input_tokens);
  const output = toFiniteNonNeg(u.output_tokens);
  if (input === null && output === null) return null;
  // input_tokens INCLUDES cached input → subtract to reach the cache-excluded
  // basis. Clamp at 0 so a malformed record can never yield a negative count.
  const cached = toFiniteNonNeg(cachedInputTokens(u)) ?? 0;
  const tokensIn = Math.max(0, (input ?? 0) - cached);
  return { tokensIn, tokensOut: output ?? 0 };
}

/** The cached-input figure, from either the rollout field or the API-shaped nesting. */
function cachedInputTokens(u: Record<string, unknown>): unknown {
  if (u.cached_input_tokens !== undefined) return u.cached_input_tokens;
  const details = u.input_tokens_details;
  if (details !== null && typeof details === "object") {
    return (details as Record<string, unknown>).cached_tokens;
  }
  return undefined;
}

function toFiniteNonNeg(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}
