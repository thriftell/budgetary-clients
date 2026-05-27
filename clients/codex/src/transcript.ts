// Adapted from clients/claude-code/src/transcript.ts. Codex's Stop hook
// payload, like Claude Code's SessionEnd, does not include session-level
// token totals — only `transcript_path` pointing at the rollout JSONL at
// `~/.codex/sessions/rollout-<ts>-<uuid>.jsonl`. The exact line schema is
// not part of Codex's stable public API; we probe the same plausible
// `usage.{input,output}_tokens` shape the Claude Code transcript uses,
// which the Codex rollout records appear to follow today.
import { existsSync, readFileSync } from "node:fs";

export interface TranscriptTotals {
  tokensIn: number;
  tokensOut: number;
}

/**
 * Best-effort parse of a Codex rollout JSONL transcript to total session-level
 * input / output tokens. Returns `null` if we can't be confident — callers
 * MUST NOT submit actuals without real token counts.
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

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const totals = extractTotals(parsed);
    if (totals) {
      tokensIn += totals.tokensIn;
      tokensOut += totals.tokensOut;
      foundAny = true;
    }
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

function extractTotals(value: unknown): TranscriptTotals | null {
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  const usage = findUsage(obj);
  if (!usage) return null;

  const inT = toFiniteNonNeg(usage.input_tokens);
  const outT = toFiniteNonNeg(usage.output_tokens);
  if (inT === null && outT === null) return null;
  return { tokensIn: inT ?? 0, tokensOut: outT ?? 0 };
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

function toFiniteNonNeg(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}
