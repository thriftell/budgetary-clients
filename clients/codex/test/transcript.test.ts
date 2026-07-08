import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTranscriptTotals } from "../src/transcript.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budgetary-codex-transcript-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(lines: unknown[]): string {
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return path;
}

// The REAL codex-rs rollout `token_count` event. `total_token_usage` is a
// cumulative running total; `input_tokens` INCLUDES `cached_input_tokens`.
function usage(o: {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}) {
  const total = o.input_tokens + o.output_tokens;
  return { ...o, total_tokens: total };
}
function tokenCount(info: unknown) {
  return {
    timestamp: "2025-10-03T16:26:57.744Z",
    type: "event_msg",
    payload: { type: "token_count", info, rate_limits: {} },
  };
}
function cumulative(o: Parameters<typeof usage>[0]) {
  const u = usage(o);
  return tokenCount({
    total_token_usage: u,
    last_token_usage: u,
    model_context_window: 272000,
  });
}

describe("readTranscriptTotals — codex token_count (real schema)", () => {
  it("takes the FINAL cumulative total on the cache-excluded basis", () => {
    // Two cumulative snapshots; only the last (authoritative) one is used.
    const path = write([
      cumulative({ input_tokens: 2944, cached_input_tokens: 2048, output_tokens: 252 }),
      cumulative({ input_tokens: 9433942, cached_input_tokens: 8803968, output_tokens: 28055 }),
    ]);
    // tokensIn = 9433942 - 8803968; tokensOut = output_tokens (already incl. reasoning).
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 629974, tokensOut: 28055 });
  });

  it("subtracts cached_input_tokens from input (cache-read-excluded basis)", () => {
    const path = write([
      cumulative({ input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200 }),
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 400, tokensOut: 200 });
  });

  it("keeps output_tokens as-is (it already includes reasoning_output_tokens)", () => {
    const path = write([
      cumulative({
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 252,
        reasoning_output_tokens: 192,
      }),
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 100, tokensOut: 252 });
  });

  it("skips a token_count event whose info is null and keeps the prior total", () => {
    const path = write([
      cumulative({ input_tokens: 500, cached_input_tokens: 100, output_tokens: 40 }),
      tokenCount(null), // codex writes info:null on the first (and sometimes last) event
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 400, tokensOut: 40 });
  });

  it("ignores non-token_count rollout lines (response_item, session_meta, …)", () => {
    const path = write([
      { type: "session_meta", payload: { id: "x" } },
      { type: "response_item", payload: { type: "function_call", name: "shell" } },
      cumulative({ input_tokens: 300, cached_input_tokens: 50, output_tokens: 25 }),
      { type: "response_item", payload: { type: "message", role: "assistant" } },
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 250, tokensOut: 25 });
  });

  it("reads the API-shaped input_tokens_details.cached_tokens nesting too", () => {
    const path = write([
      tokenCount({
        total_token_usage: {
          input_tokens: 900,
          input_tokens_details: { cached_tokens: 300 },
          output_tokens: 10,
          total_tokens: 910,
        },
      }),
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 600, tokensOut: 10 });
  });

  it("clamps to 0 rather than emit a negative count if cached exceeds input", () => {
    const path = write([
      cumulative({ input_tokens: 100, cached_input_tokens: 250, output_tokens: 5 }),
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 0, tokensOut: 5 });
  });
});

describe("readTranscriptTotals — codex fails closed on unrecognized shapes", () => {
  it("returns null for an Anthropic-style usage line (not a codex token_count)", () => {
    // The OLD parser summed these; the corrected one refuses a shape it can't
    // trust rather than emit a confidently-wrong Codex total.
    const path = write([
      { type: "assistant", message: { id: "m", usage: { input_tokens: 10, output_tokens: 5 } } },
      { usage: { input_tokens: 7, output_tokens: 3 } },
    ]);
    expect(readTranscriptTotals(path)).toBeNull();
  });

  it("returns null for a rollout with no token_count event at all", () => {
    const path = write([
      { type: "session_meta", payload: {} },
      { type: "response_item", payload: { type: "function_call" } },
    ]);
    expect(readTranscriptTotals(path)).toBeNull();
  });

  it("fails closed to null: missing, empty, unparseable-only", () => {
    expect(readTranscriptTotals(join(dir, "nope.jsonl"))).toBeNull();
    expect(readTranscriptTotals(write([]))).toBeNull();
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, "not json\n{ truncated\n", "utf8");
    expect(readTranscriptTotals(bad)).toBeNull();
  });
});
