import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTranscriptTotals } from "../src/transcript.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budgetary-cc-transcript-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(lines: unknown[]): string {
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return path;
}

// The REAL Claude Code transcript shape: one JSONL line per content block, every
// line of a turn repeating the same turn-level `usage`.
const thinking = { type: "thinking", thinking: "…" };
const text = { type: "text", text: "…" };
const toolUse = (name: string) => ({ type: "tool_use", id: "tu", name, input: {} });
function line(id: string, block: unknown, usage: Record<string, number>) {
  return {
    type: "assistant",
    message: { id, role: "assistant", content: [block], usage },
  };
}

describe("readTranscriptTotals — per-turn granularity (the crux)", () => {
  it("dedupes repeated per-content-block usage by message.id (no 3-4x over-count)", () => {
    // One turn written across 4 lines (thinking, text, Read, Bash), all carrying
    // the SAME usage. Naive per-line summation would 4x the real total.
    const u = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 9000 };
    const path = write([
      line("msg_a", thinking, u),
      line("msg_a", text, u),
      line("msg_a", toolUse("Read"), u),
      line("msg_a", toolUse("Bash"), u),
    ]);
    // Counted ONCE, cache_read excluded.
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 100, tokensOut: 20 });
  });

  it("sums across distinct turns", () => {
    const path = write([
      line("msg_1", toolUse("Read"), { input_tokens: 100, output_tokens: 20 }),
      line("msg_1", toolUse("Bash"), { input_tokens: 100, output_tokens: 20 }),
      line("msg_2", toolUse("Edit"), { input_tokens: 2, output_tokens: 30 }),
      line("msg_3", text, { input_tokens: 2, output_tokens: 500 }),
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 104, tokensOut: 550 });
  });

  it("handles an old single-line-per-message turn with all blocks inline", () => {
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
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 100, tokensOut: 20 });
  });
});

describe("readTranscriptTotals — back-compat & robustness", () => {
  it("does not dedupe lines that carry usage but no message.id", () => {
    // Older single-line / synthetic transcripts each form their own turn and
    // were never over-counted, so totals are unchanged.
    const path = write([
      { message: { usage: { input_tokens: 10, output_tokens: 5 } } },
      { message: { usage: { input_tokens: 7, output_tokens: 3 } } },
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 17, tokensOut: 8 });
  });

  it("excludes cache_read_input_tokens from totals", () => {
    const path = write([
      line("msg_x", toolUse("Read"), {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 9_000_000,
        cache_creation_input_tokens: 2000,
      }),
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 1000, tokensOut: 500 });
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
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 5, tokensOut: 5 });
  });

  it("fails closed to null: missing, empty, no-usage", () => {
    expect(readTranscriptTotals(join(dir, "nope.jsonl"))).toBeNull();
    expect(readTranscriptTotals(write([]))).toBeNull();
    expect(
      readTranscriptTotals(write([{ type: "user", message: { content: "hi" } }])),
    ).toBeNull();
  });
});
