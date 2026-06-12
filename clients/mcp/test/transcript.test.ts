import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TRACE_MAX_BYTES,
  TRACE_MAX_STEPS,
  capTrace,
  readTranscriptTotals,
  readTranscriptUsage,
  type TraceStep,
} from "../src/transcript.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budgetary-transcript-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(lines: unknown[]): string {
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return path;
}

// Mirrors the REAL Claude Code transcript shape: one JSONL line per content
// block, every line of a turn repeating the same turn-level `usage`.
const thinking = { type: "thinking", thinking: "…" };
const text = { type: "text", text: "…" };
const toolUse = (name: string) => ({ type: "tool_use", id: "tu", name, input: {} });
function line(id: string, block: unknown, usage: Record<string, number>) {
  return {
    type: "assistant",
    message: { id, role: "assistant", content: [block], usage },
  };
}

describe("readTranscriptUsage — per-turn granularity (the crux)", () => {
  it("dedupes repeated per-content-block usage by message.id", () => {
    // One turn written across 4 lines (thinking, text, Read, Bash), all
    // carrying the SAME usage. Naive per-line summation would 4× the total.
    const u = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 9000 };
    const path = write([
      line("msg_a", thinking, u),
      line("msg_a", text, u),
      line("msg_a", toolUse("Read"), u),
      line("msg_a", toolUse("Bash"), u),
    ]);

    const usage = readTranscriptUsage(path);
    expect(usage).not.toBeNull();
    // Counted ONCE, cache_read excluded.
    expect(usage!.tokensIn).toBe(100);
    expect(usage!.tokensOut).toBe(20);
    // Two tools in one measured turn → even split, each flagged turn-split.
    expect(usage!.trace).toEqual([
      { tool: "Read", tokens: 60, kind: "turn-split" },
      { tool: "Bash", tokens: 60, kind: "turn-split" },
    ]);
  });

  it("emits a single un-flagged step for a one-tool turn", () => {
    const u = { input_tokens: 2, output_tokens: 30 };
    const path = write([
      line("msg_b", thinking, u),
      line("msg_b", text, u),
      line("msg_b", toolUse("Edit"), u),
    ]);
    const usage = readTranscriptUsage(path);
    expect(usage!.tokensIn).toBe(2);
    expect(usage!.tokensOut).toBe(30);
    expect(usage!.trace).toEqual([{ tool: "Edit", tokens: 32 }]);
  });

  it("front-loads the integer remainder so split steps sum to the turn total", () => {
    const u = { input_tokens: 101, output_tokens: 20 }; // 121 across 2 tools
    const path = write([
      line("msg_c", toolUse("Read"), u),
      line("msg_c", toolUse("Grep"), u),
    ]);
    const trace = readTranscriptUsage(path)!.trace;
    expect(trace).toEqual([
      { tool: "Read", tokens: 61, kind: "turn-split" },
      { tool: "Grep", tokens: 60, kind: "turn-split" },
    ]);
    expect(trace.reduce((s, x) => s + x.tokens, 0)).toBe(121);
  });

  it("counts a text/thinking-only turn in the total but emits no step", () => {
    const path = write([
      line("msg_d", thinking, { input_tokens: 2, output_tokens: 500 }),
      line("msg_d", text, { input_tokens: 2, output_tokens: 500 }),
    ]);
    const usage = readTranscriptUsage(path)!;
    expect(usage.tokensOut).toBe(500);
    expect(usage.trace).toEqual([]);
  });

  it("sums across turns and preserves first-seen order in the trace", () => {
    const path = write([
      line("msg_1", toolUse("Read"), { input_tokens: 100, output_tokens: 20 }),
      line("msg_1", toolUse("Bash"), { input_tokens: 100, output_tokens: 20 }),
      line("msg_2", toolUse("Edit"), { input_tokens: 2, output_tokens: 30 }),
      line("msg_3", text, { input_tokens: 2, output_tokens: 500 }),
    ]);
    const usage = readTranscriptUsage(path)!;
    expect(usage).toMatchObject({ tokensIn: 104, tokensOut: 550 });
    expect(usage.trace).toEqual([
      { tool: "Read", tokens: 60, kind: "turn-split" },
      { tool: "Bash", tokens: 60, kind: "turn-split" },
      { tool: "Edit", tokens: 32 },
    ]);
  });
});

describe("readTranscriptUsage — back-compat & robustness", () => {
  it("does not dedupe lines that carry usage but no message.id", () => {
    // Older single-line / synthetic transcripts each form their own turn and
    // were never over-counted, so totals are unchanged.
    const path = write([
      { message: { usage: { input_tokens: 10, output_tokens: 5 } } },
      { message: { usage: { input_tokens: 7, output_tokens: 3 } } },
    ]);
    const totals = readTranscriptTotals(path);
    expect(totals).toEqual({ tokensIn: 17, tokensOut: 8 });
  });

  it("handles an old single-line-per-message turn with all blocks inline", () => {
    // One line, full content array, single usage, distinct message.id.
    const path = write([
      {
        type: "assistant",
        message: {
          id: "msg_inline",
          content: [thinking, text, toolUse("Read"), toolUse("Bash")],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
    ]);
    const usage = readTranscriptUsage(path)!;
    expect(usage.tokensIn).toBe(100);
    expect(usage.trace).toEqual([
      { tool: "Read", tokens: 60, kind: "turn-split" },
      { tool: "Bash", tokens: 60, kind: "turn-split" },
    ]);
  });

  it("excludes cache_read_input_tokens from totals and split steps", () => {
    const path = write([
      line("msg_x", toolUse("Read"), {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 9_000_000,
        cache_creation_input_tokens: 2000,
      }),
    ]);
    const usage = readTranscriptUsage(path)!;
    expect(usage).toMatchObject({ tokensIn: 1000, tokensOut: 500 });
    expect(usage.trace).toEqual([{ tool: "Read", tokens: 1500 }]);
  });

  it("skips unparseable lines but keeps real ones", () => {
    const path = join(dir, "mixed.jsonl");
    writeFileSync(
      path,
      [
        "not json",
        "",
        JSON.stringify(line("msg_ok", toolUse("Read"), { input_tokens: 5, output_tokens: 5 })),
        "{ truncated",
      ].join("\n"),
      "utf8",
    );
    const usage = readTranscriptUsage(path)!;
    expect(usage.tokensIn).toBe(5);
    expect(usage.trace).toEqual([{ tool: "Read", tokens: 10 }]);
  });

  it("fails closed to null: missing, empty, no-usage", () => {
    expect(readTranscriptUsage(join(dir, "nope.jsonl"))).toBeNull();
    expect(readTranscriptUsage(write([]))).toBeNull();
    expect(readTranscriptUsage(write([{ type: "user", message: { content: "hi" } }]))).toBeNull();
  });
});

describe("capTrace — cap + fail-closed", () => {
  it("returns null for an empty trace", () => {
    expect(capTrace([])).toBeNull();
  });

  it("returns the trace unchanged when within both caps", () => {
    const trace: TraceStep[] = [{ tool: "Read", tokens: 1 }, { tool: "Bash", tokens: 2 }];
    expect(capTrace(trace)).toBe(trace);
  });

  it("drops a trace over the step cap", () => {
    const trace = Array.from({ length: TRACE_MAX_STEPS + 1 }, () => ({
      tool: "Read",
      tokens: 1,
    }));
    expect(capTrace(trace)).toBeNull();
  });

  it("drops a trace over the byte cap even within the step cap", () => {
    const longName = "T".repeat(60);
    const trace = Array.from({ length: 300 }, () => ({ tool: longName, tokens: 999999 }));
    expect(trace.length).toBeLessThanOrEqual(TRACE_MAX_STEPS);
    expect(Buffer.byteLength(JSON.stringify(trace), "utf8")).toBeGreaterThan(TRACE_MAX_BYTES);
    expect(capTrace(trace)).toBeNull();
  });
});
