import { existsSync, readFileSync } from "node:fs";

export interface TranscriptTotals {
  tokensIn: number;
  tokensOut: number;
}

/**
 * Best-effort parse of a Claude Code transcript JSONL file to total
 * session-level input / output tokens. The transcript schema is not part
 * of the documented hook contract (the SessionEnd payload only exposes
 * `transcript_path`); we therefore probe several plausible field names
 * and return `null` if we can't be confident.
 *
 * THE GRANULARITY FACT (verified against real Claude Code transcripts, and
 * mirrored from `clients/mcp/src/transcript.ts`): token `usage` is reported
 * **per turn** (per assistant `message.id`), never per content block. The
 * current transcript writes one JSONL line per content block (thinking / text /
 * each `tool_use`) and every one of those lines repeats the SAME turn-level
 * `usage`. Summing every line therefore multiplies the real spend by the number
 * of content blocks per turn (≈3–4×). We dedupe by `message.id`: the first line
 * of a turn carries the canonical usage and later repeats are never re-added. A
 * usage line with no `message.id` (older single-line transcripts, synthetic
 * fixtures) each forms its own turn — those were never over-counted, so their
 * totals are unchanged.
 *
 * Token basis is `input_tokens + output_tokens`. `cache_read_input_tokens` is
 * deliberately EXCLUDED — the Anthropic usage object's `input_tokens` already
 * omits cache reads, so we neither add nor re-subtract them.
 *
 * Returning `null` is load-bearing: callers MUST NOT submit actuals
 * without real token counts.
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

  let tokensIn = 0;
  let tokensOut = 0;
  let foundAny = false;
  // A turn is counted once, keyed by its assistant `message.id`; a usage line
  // without one forms its own turn (keyed by line number) and is unchanged.
  const seen = new Set<string>();
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
    if (seen.has(key)) continue; // repeated per-content-block line → count once
    seen.add(key);

    tokensIn += inT ?? 0;
    tokensOut += outT ?? 0;
    foundAny = true;
  }

  if (!foundAny) return null;
  return { tokensIn, tokensOut };
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

function toFiniteNonNeg(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}
