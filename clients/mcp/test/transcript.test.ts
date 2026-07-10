import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TRANSCRIPT_BYTES,
  TRACE_MAX_BYTES,
  TRACE_MAX_STEPS,
  capTrace,
  readTranscriptTotals,
  readTranscriptUsage,
  redactBashTarget,
  redactFileTarget,
  redactTarget,
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
// A tool_use with a real id + input, so target/ok enrichment has something to read.
const use = (name: string, id: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id,
  name,
  input,
});
function line(id: string, block: unknown, usage: Record<string, number>) {
  return {
    type: "assistant",
    message: { id, role: "assistant", content: [block], usage },
  };
}
// A user line carrying a tool_result outcome (the shape Claude Code writes —
// `is_error` present on shell results, often absent on a successful file read).
function resultLine(
  toolUseId: string,
  isError?: boolean,
): Record<string, unknown> {
  const block: Record<string, unknown> = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: "…",
  };
  if (isError !== undefined) block.is_error = isError;
  return { type: "user", message: { role: "user", content: [block] } };
}
// Strip the trailing 12-hex digest, leaving only what a target exposes in clear.
const clearOf = (target: string) => target.replace(/\s[0-9a-f]{12}$/, "");

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

  it("size-guards BEFORE reading: over-cap file with valid content still yields null", () => {
    // Control: this exact content, in a small file, parses to real usage — so a
    // null result for the same content over the cap can only be the SIZE guard.
    const validLine =
      JSON.stringify(line("m1", toolUse("Read"), { input_tokens: 100, output_tokens: 20 })) + "\n";
    const small = join(dir, "small.jsonl");
    writeFileSync(small, validLine, "utf8");
    expect(readTranscriptUsage(small)).not.toBeNull();

    // Over-cap: the SAME valid first line, then sparse NUL padding past the cap.
    // If the whole file were read (guard removed) the first line would parse to
    // non-null usage — so this asserting null locks in the size guard.
    const huge = join(dir, "huge.jsonl");
    writeFileSync(huge, validLine, "utf8");
    truncateSync(huge, MAX_TRANSCRIPT_BYTES + 1);
    expect(readTranscriptUsage(huge)).toBeNull();
  });

  it("rejects a non-regular path (a FIFO would read unbounded / block)", () => {
    // The `!isFile()` branch: a FIFO reports size 0, so only the regular-file
    // check stops an unbounded/blocking read. Guard present → fast null; a
    // regression that dropped the check would block on the writer-less FIFO.
    const fifo = join(dir, "pipe.jsonl");
    let made = false;
    try {
      execFileSync("mkfifo", [fifo]);
      made = true;
    } catch {
      // mkfifo unavailable (e.g. Windows) — skip; CI (linux) and macOS have it.
    }
    if (made) expect(readTranscriptUsage(fifo)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Codex rollout dialect: the runtime parses BOTH the Claude Code per-turn shape
// and the Codex cumulative `token_count` shape, detected by content.
// ---------------------------------------------------------------------------

// A real codex-rs cumulative `token_count` event. `total_token_usage` is a
// running total; `input_tokens` INCLUDES `cached_input_tokens`.
function codexCumulative(o: {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
}) {
  const total_token_usage = { ...o, total_tokens: o.input_tokens + o.output_tokens };
  return {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage, last_token_usage: total_token_usage },
    },
  };
}

describe("readTranscriptUsage — Codex rollout dialect", () => {
  it("parses a token_count rollout to cache-excluded totals with an empty trace", () => {
    // Two cumulative snapshots; only the last (authoritative) one is used.
    const path = write([
      codexCumulative({ input_tokens: 2944, cached_input_tokens: 2048, output_tokens: 252 }),
      codexCumulative({ input_tokens: 9433942, cached_input_tokens: 8803968, output_tokens: 28055 }),
    ]);
    // tokensIn = 9433942 − 8803968; the rollout carries no per-tool data → [].
    expect(readTranscriptUsage(path)).toEqual({
      tokensIn: 629974,
      tokensOut: 28055,
      trace: [],
    });
  });

  it("readTranscriptTotals returns the same cache-excluded totals for a rollout", () => {
    const path = write([
      codexCumulative({ input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200 }),
    ]);
    expect(readTranscriptTotals(path)).toEqual({ tokensIn: 400, tokensOut: 200 });
  });

  it("keeps the LAST cumulative record and skips info:null events", () => {
    const path = write([
      codexCumulative({ input_tokens: 500, cached_input_tokens: 100, output_tokens: 40 }),
      { type: "event_msg", payload: { type: "token_count", info: null } },
    ]);
    expect(readTranscriptUsage(path)).toEqual({ tokensIn: 400, tokensOut: 40, trace: [] });
  });

  it("reads the API-shaped input_tokens_details.cached_tokens nesting", () => {
    const path = write([
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 900,
              input_tokens_details: { cached_tokens: 300 },
              output_tokens: 10,
              total_tokens: 910,
            },
          },
        },
      },
    ]);
    expect(readTranscriptUsage(path)).toEqual({ tokensIn: 600, tokensOut: 10, trace: [] });
  });

  it("clamps to 0 rather than a negative count when cached exceeds input", () => {
    const path = write([
      codexCumulative({ input_tokens: 100, cached_input_tokens: 250, output_tokens: 5 }),
    ]);
    expect(readTranscriptUsage(path)).toEqual({ tokensIn: 0, tokensOut: 5, trace: [] });
  });

  it("still parses a Claude Code transcript (no token_count) via the per-turn path", () => {
    const path = write([
      line("msg_cc", toolUse("Read"), { input_tokens: 100, output_tokens: 20 }),
    ]);
    const usage = readTranscriptUsage(path)!;
    expect(usage.tokensIn).toBe(100);
    expect(usage.tokensOut).toBe(20);
    expect(usage.trace).toEqual([{ tool: "Read", tokens: 120 }]);
  });

  it("does not mis-read a Claude transcript that literally contains \"token_count\" as Codex", () => {
    // The Codex fast-path marker is the substring `"token_count"`. It can appear
    // verbatim in a Claude transcript (here as a message's text value), which
    // must still fall through to the per-turn path — never be parsed as a Codex
    // rollout. Guards the marker heuristic against a false positive.
    const path = write([
      line("msg_fp", { type: "text", text: "token_count" }, { input_tokens: 100, output_tokens: 20 }),
    ]);
    expect(readTranscriptUsage(path)).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      trace: [],
    });
  });

  it("fails closed to null on a file that is neither dialect", () => {
    const path = write([
      { type: "session_meta", payload: {} },
      { type: "response_item", payload: { type: "function_call" } },
    ]);
    expect(readTranscriptUsage(path)).toBeNull();
  });

  it("skips a half-measured record (output missing) and keeps the last full one", () => {
    // A malformed final record must not submit a fabricated tokensOut:0 — the
    // reader falls back to the last fully-measured record.
    const path = write([
      codexCumulative({ input_tokens: 300, cached_input_tokens: 50, output_tokens: 25 }),
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 999, cached_input_tokens: 0 } } } },
    ]);
    expect(readTranscriptUsage(path)).toEqual({ tokensIn: 250, tokensOut: 25, trace: [] });
  });

  it("returns null when the only record is half-measured (fail closed, no zeroed half)", () => {
    const path = write([
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { output_tokens: 5 } } } },
    ]);
    expect(readTranscriptUsage(path)).toBeNull();
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

// ---------------------------------------------------------------------------
// Target redaction — the crux: utility (program in the clear + a stable key)
// WITHOUT leakage (no raw path / argument / command / secret).
// ---------------------------------------------------------------------------

const DIGEST = /^[0-9a-f]{12}$/;

describe("redactBashTarget", () => {
  it("exposes the leading program and hides everything else in a digest", () => {
    const t = redactBashTarget("pytest -x tests/test_secret_paths.py")!;
    expect(t).toMatch(/^pytest [0-9a-f]{12}$/);
    expect(t).not.toContain("/");
    expect(t).not.toContain("test_secret_paths");
  });

  it("keeps an allowlisted subcommand for a known driver (server second-token rule)", () => {
    expect(redactBashTarget("go test ./...")!).toMatch(/^go test [0-9a-f]{12}$/);
    expect(redactBashTarget("npm run build:prod")!).toMatch(/^npm run [0-9a-f]{12}$/);
    expect(redactBashTarget("pip install requests")!).toMatch(/^pip install [0-9a-f]{12}$/);
  });

  it("does NOT expose a free-form driver argument (script / target / file name)", () => {
    // The second token is exposed only when it is an allowlisted KEYWORD, never a
    // free-form script/target/module name — otherwise it would leak an argument.
    expect(redactBashTarget("node run.js")!).toMatch(/^node [0-9a-f]{12}$/);
    expect(redactBashTarget("python app_secret.py")!).toMatch(/^python [0-9a-f]{12}$/);
    expect(redactBashTarget("make deploy-prod-secrets")!).toMatch(/^make [0-9a-f]{12}$/);
    expect(redactBashTarget("rake db:migrate:prod")!).toMatch(/^rake [0-9a-f]{12}$/);
    // git's verbs are not in the build/test/package allowlist → program only.
    expect(redactBashTarget('git commit -m "ship it"')!).toMatch(/^git [0-9a-f]{12}$/);
  });

  it("surfaces only an allowlisted `python -m <module>` runner", () => {
    expect(redactBashTarget("python -m pytest -q")!).toMatch(/^python pytest [0-9a-f]{12}$/);
    expect(redactBashTarget("python3 -m unittest")!).toMatch(/^python3 unittest [0-9a-f]{12}$/);
    // A private/free-form module is never exposed.
    expect(redactBashTarget("python -m mycompany.secret_runner")!).toMatch(/^python [0-9a-f]{12}$/);
  });

  it("exposes an allowlisted package-runner tool as the second token (0019e)", () => {
    // `npx`/`bunx` — the runner tool is one token past the preamble.
    expect(redactBashTarget("npx jest --ci")!).toMatch(/^npx jest [0-9a-f]{12}$/);
    expect(redactBashTarget("npx vitest run")!).toMatch(/^npx vitest [0-9a-f]{12}$/);
    expect(redactBashTarget("bunx vitest run")!).toMatch(/^bunx vitest [0-9a-f]{12}$/);
    // `pnpm dlx`/`yarn dlx` — the runner tool is two tokens past; only the
    // preamble program + runner reach the clear (NOT the runner's own subcommand).
    expect(redactBashTarget("pnpm dlx playwright test e2e/login.spec.ts")!).toMatch(
      /^pnpm playwright [0-9a-f]{12}$/,
    );
    expect(redactBashTarget("yarn dlx vitest run src/secret.test.ts")!).toMatch(
      /^yarn vitest [0-9a-f]{12}$/,
    );
    // tsc / eslint / cypress / nyc / c8 are runners too.
    expect(redactBashTarget("npx tsc --noEmit")!).toMatch(/^npx tsc [0-9a-f]{12}$/);
    expect(redactBashTarget("npx eslint .")!).toMatch(/^npx eslint [0-9a-f]{12}$/);
  });

  it("never exposes a non-allowlisted (private) package name run via a runner", () => {
    // The leak crux: a free-form package name is exactly the token that can carry
    // a private/internal identifier, so anything outside RUNNER_TOOLS stays in the
    // digest — the target degrades to the bare preamble program.
    expect(redactBashTarget("npx my-private-cli --deploy")!).toMatch(/^npx [0-9a-f]{12}$/);
    expect(redactBashTarget("npx @acme/secret-codegen")!).toMatch(/^npx [0-9a-f]{12}$/);
    expect(redactBashTarget("bunx internal-tool")!).toMatch(/^bunx [0-9a-f]{12}$/);
    expect(redactBashTarget("pnpm dlx @acme/private-pkg")!).toMatch(/^pnpm [0-9a-f]{12}$/);
    // prettier is deliberately excluded — formatting is not verification.
    expect(redactBashTarget("npx prettier --write .")!).toMatch(/^npx [0-9a-f]{12}$/);
    // A versioned/scoped runner spec is not a bare allowlist member → digest-only.
    expect(redactBashTarget("npx jest@29 --ci")!).toMatch(/^npx [0-9a-f]{12}$/);
    // `pnpm test` (no `dlx`) is still the ordinary driver-subcommand path.
    expect(redactBashTarget("pnpm test")!).toMatch(/^pnpm test [0-9a-f]{12}$/);
    // `pnpm dlx <private>` does NOT fall through to expose `dlx` either.
    expect(redactBashTarget("pnpm dlx some-private-tool")!).not.toContain("dlx");
  });

  it("peels a leading `cd <dir> &&` preamble without leaking the path", () => {
    const t = redactBashTarget("cd /Users/alice/secret-repo && pytest -q")!;
    expect(t).toMatch(/^pytest [0-9a-f]{12}$/);
    expect(t).not.toContain("secret-repo");
    expect(t).not.toContain("/");
  });

  it("peels a leading `source <file> &&` preamble", () => {
    expect(
      redactBashTarget("source .venv/bin/activate && python -m pytest")!,
    ).toMatch(/^python pytest [0-9a-f]{12}$/);
  });

  it("strips a leading secret env-assignment — the value never appears", () => {
    const t = redactBashTarget("API_KEY=sk-live-supersecret pytest tests/")!;
    expect(t).toMatch(/^pytest [0-9a-f]{12}$/);
    expect(t).not.toContain("sk-live-supersecret");
    expect(t).not.toContain("API_KEY");
    expect(t).not.toContain("=");
  });

  it("keeps a balanced quoted env value but never leaks one with interior spaces", () => {
    // Balanced, space-free quoted value → safely consumed, program still found.
    expect(
      redactBashTarget('NODE_OPTIONS="--max-old-space-size=4096" npm test')!,
    ).toMatch(/^npm test [0-9a-f]{12}$/);
    // Quoted value WITH interior spaces would split across tokens → fail closed,
    // so no interior word of the secret can surface as the program.
    const t = redactBashTarget('PGPASSWORD="prod db hunter2 secret" psql -h h');
    expect(t).toBeNull();
  });

  it("never reads past the first logical line (heredoc / multi-line bodies)", () => {
    // The classic leak: a `cd`/`source` first line, then a later line whose text
    // (heredoc body, pasted PR/commit prose, a secret) must never become the program.
    const heredoc =
      "cd /home/me/proj\n" +
      "gh pr create --body \"$(cat <<'EOF'\n" +
      "per-neighbor weight is kernel(distance) only\n" +
      "SUPERSECRETtoken_abc123\n" +
      "EOF\n)\"";
    const t = redactBashTarget(heredoc)!;
    expect(t).toMatch(/^cd [0-9a-f]{12}$/); // program = the first-line builtin only
    expect(t).not.toContain("per-neighbor");
    expect(t).not.toContain("SUPERSECRETtoken_abc123");
    // A semicolon on a LATER line must not be reached either.
    const later = redactBashTarget("cd /a/b\necho hi ; INJECTEDsecret_abc123")!;
    expect(later).toMatch(/^cd [0-9a-f]{12}$/);
    expect(later).not.toContain("INJECTEDsecret_abc123");
  });

  it("basenames an absolute path to the program binary", () => {
    expect(redactBashTarget("/usr/local/bin/pytest -q")!).toMatch(/^pytest [0-9a-f]{12}$/);
    expect(redactBashTarget(".venv/bin/pytest -q")!).toMatch(/^pytest [0-9a-f]{12}$/);
  });

  it("is stable for identical operations under one salt, distinct for different args / salts", () => {
    const salt = Buffer.from("one-submission-salt");
    // Same salt (one submission): identical operations share a target (retry key).
    expect(redactBashTarget("pytest -q tests/", salt)).toBe(
      redactBashTarget("pytest -q  tests/", salt),
    );
    expect(redactBashTarget("pytest tests/a.py", salt)).not.toBe(
      redactBashTarget("pytest tests/b.py", salt),
    );
    // Different submission salt → the SAME command hashes to a different digest,
    // so a precomputed dictionary of plain hashes cannot reverse it.
    expect(redactBashTarget("pytest -q", Buffer.from("salt-a"))).not.toBe(
      redactBashTarget("pytest -q", Buffer.from("salt-b")),
    );
  });

  it("cleartext program is ALLOWLIST-gated, not charset-gated (the leak crux)", () => {
    const salt = Buffer.from("fixed-test-salt");
    // A pasted credential as the first token is well-formed but NOT allowlisted →
    // bare salted digest, never cleartext.
    const gh = redactBashTarget("ghp_AbCd1234EfGh5678 --help", salt)!;
    expect(gh).toMatch(/^[0-9a-f]{12}$/);
    expect(gh).not.toContain("ghp_");
    const sk = redactBashTarget("sk-ant-api03-SUPERSECRET tests/", salt)!;
    expect(sk).toMatch(/^[0-9a-f]{12}$/);
    expect(sk).not.toContain("sk-ant");
    // A private/unlisted script or binary name → bare digest (was cleartext under
    // the old charset gate).
    const script = redactBashTarget("rotate_prod_keys.sh --prod", salt)!;
    expect(script).toMatch(/^[0-9a-f]{12}$/);
    expect(script).not.toContain("rotate_prod_keys");
    expect(redactBashTarget("deploy-secrets --now", salt)!).toMatch(/^[0-9a-f]{12}$/);
    // Common, non-sensitive programs are still exposed for server classification.
    expect(redactBashTarget("pytest -q", salt)!).toMatch(/^pytest [0-9a-f]{12}$/);
    expect(redactBashTarget("go test ./...", salt)!).toMatch(/^go test [0-9a-f]{12}$/);
  });

  it("fails closed on a backslash-escaped env value (no later token surfaces as program)", () => {
    // `TOKEN=abc\ ghp_real cmd`: the escaped space would split the value, leaving
    // `ghp_real` as the next token → the program. Refuse rather than tokenize in.
    expect(redactBashTarget("TOKEN=abc\\ ghp_realtoken aws s3", Buffer.from("s"))).toBeNull();
  });

  it("fails closed when no clean program name is available", () => {
    expect(redactBashTarget("")).toBeNull();
    expect(redactBashTarget("   ")).toBeNull();
    expect(redactBashTarget('"quoted prog" --flag')).toBeNull();
    expect(redactBashTarget("$RUNNER --x")).toBeNull();
  });

  it("never leaks a path/arg/secret across a battery of adversarial commands", () => {
    const secrets = ["sk-LEAKME", "/Users/bob/private", "PASSWORD=hunter2", "topsecret.key"];
    const cmds = [
      "pytest /Users/bob/private/tests --token sk-LEAKME",
      "cd /Users/bob/private && PASSWORD=hunter2 go test ./pkg/topsecret.key",
      "AWS_SECRET=sk-LEAKME aws s3 cp topsecret.key s3://b",
      "grep -rn sk-LEAKME /Users/bob/private",
      "node /Users/bob/private/run.js --password hunter2",
      "docker run -e PASSWORD=hunter2 img topsecret.key",
      "source /Users/bob/private/.env && pytest",
      "npx jest --token sk-LEAKME /Users/bob/private",
      "pnpm dlx playwright test topsecret.key --password hunter2",
      "npx sk-LEAKME-private-cli /Users/bob/private",
    ];
    for (const cmd of cmds) {
      const t = redactBashTarget(cmd);
      if (t === null) continue;
      const clear = clearOf(t);
      // The cleartext is only "<program>" or "<program> <subcommand>".
      expect(clear.split(" ").length).toBeLessThanOrEqual(2);
      expect(clear).not.toMatch(/[/=]/);
      for (const s of secrets) expect(t).not.toContain(s);
    }
  });
});

describe("redactFileTarget", () => {
  it("returns an opaque digest, never the path", () => {
    const t = redactFileTarget("/Users/alice/secret/creds.env")!;
    expect(t).toMatch(DIGEST);
    expect(t).not.toContain("creds");
    expect(t).not.toContain("/");
  });

  it("is stable per path under one salt (a retry key), distinct across files / salts", () => {
    const salt = Buffer.from("one-submission-salt");
    expect(redactFileTarget("/a/b/c.ts", salt)).toBe(redactFileTarget("/a/b/c.ts", salt));
    expect(redactFileTarget("/a/b/c.ts", salt)).not.toBe(redactFileTarget("/a/b/d.ts", salt));
    // Different submission salt → different digest for the same path.
    expect(redactFileTarget("/a/b/c.ts", Buffer.from("s1"))).not.toBe(
      redactFileTarget("/a/b/c.ts", Buffer.from("s2")),
    );
  });

  it("fails closed on an empty path", () => {
    expect(redactFileTarget("")).toBeNull();
    expect(redactFileTarget("   ")).toBeNull();
  });
});

describe("redactTarget — per-tool dispatch", () => {
  it("redacts Bash via the command", () => {
    expect(redactTarget("Bash", { command: "pytest -q" })!).toMatch(/^pytest [0-9a-f]{12}$/);
    expect(redactTarget("Bash", {})).toBeNull();
  });

  it("redacts any path-bearing file tool to a bare digest", () => {
    expect(redactTarget("Read", { file_path: "/x/y.ts" })!).toMatch(DIGEST);
    expect(redactTarget("Edit", { file_path: "/x/y.ts" })!).toMatch(DIGEST);
    expect(redactTarget("NotebookEdit", { notebook_path: "/x/y.ipynb" })!).toMatch(DIGEST);
    expect(redactTarget("Grep", { path: "/x", pattern: "needle" })!).toMatch(DIGEST);
  });

  it("omits a target for a tool with no command and no path", () => {
    expect(redactTarget("TodoWrite", { todos: [] })).toBeNull();
    expect(redactTarget("WebFetch", { url: "https://x" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Trace enrichment end-to-end: target + ok measured off the transcript.
// ---------------------------------------------------------------------------

describe("readTranscriptUsage — target + ok enrichment", () => {
  it("attaches target and ok=false to a failed shell step", () => {
    const u = { input_tokens: 100, output_tokens: 49 };
    const path = write([
      line("m1", use("Bash", "b1", { command: "python -m pytest -q" }), u),
      resultLine("b1", true), // shell failure
    ]);
    const [step] = readTranscriptUsage(path)!.trace;
    expect(step!.tool).toBe("Bash");
    expect(step!.target).toMatch(/^python pytest [0-9a-f]{12}$/);
    expect(step!.ok).toBe(false);
  });

  it("attaches ok=true to a succeeded shell step", () => {
    const path = write([
      line("m1", use("Bash", "b1", { command: "npm test" }), { input_tokens: 1, output_tokens: 1 }),
      resultLine("b1", false),
    ]);
    expect(readTranscriptUsage(path)!.trace[0]).toMatchObject({
      tool: "Bash",
      ok: true,
    });
  });

  it("omits ok when the host flagged no outcome (successful file read)", () => {
    const path = write([
      line("m1", use("Read", "r1", { file_path: "/repo/src/a.ts" }), { input_tokens: 5, output_tokens: 5 }),
      resultLine("r1"), // no is_error written → success, but unknown to us
    ]);
    const step = readTranscriptUsage(path)!.trace[0]!;
    expect(step.target).toMatch(DIGEST); // still a retry key
    expect("ok" in step).toBe(false); // never fabricated
  });

  it("omits ok when no tool_result is present at all", () => {
    const path = write([
      line("m1", use("Edit", "e1", { file_path: "/repo/a.ts" }), { input_tokens: 5, output_tokens: 5 }),
    ]);
    const step = readTranscriptUsage(path)!.trace[0]!;
    expect("ok" in step).toBe(false);
  });

  it("enriches each tool of a multi-tool turn independently (token split unchanged)", () => {
    const u = { input_tokens: 100, output_tokens: 20 }; // 120 across 2 tools
    const path = write([
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [
            use("Read", "r1", { file_path: "/repo/a.ts" }),
            use("Bash", "b1", { command: "go test ./..." }),
          ],
          usage: u,
        },
      },
      resultLine("r1"), // file read: no is_error → no ok
      resultLine("b1", false), // shell success → ok true
    ]);
    const trace = readTranscriptUsage(path)!.trace;
    expect(trace[0]).toMatchObject({ tool: "Read", tokens: 60, kind: "turn-split" });
    expect(trace[0]!.target).toMatch(DIGEST);
    expect("ok" in trace[0]!).toBe(false);
    expect(trace[1]).toMatchObject({ tool: "Bash", tokens: 60, kind: "turn-split", ok: true });
    expect(trace[1]!.target).toMatch(/^go test [0-9a-f]{12}$/);
  });

  it("repeated failed operations share a target (server-side retry key)", () => {
    const path = write([
      line("m1", use("Bash", "b1", { command: "pytest -q" }), { input_tokens: 5, output_tokens: 5 }),
      resultLine("b1", true),
      line("m2", use("Bash", "b2", { command: "pytest -q" }), { input_tokens: 5, output_tokens: 5 }),
      resultLine("b2", true),
    ]);
    const trace = readTranscriptUsage(path)!.trace;
    expect(trace[0]!.target).toBe(trace[1]!.target);
    expect(trace[0]!.ok).toBe(false);
    expect(trace[1]!.ok).toBe(false);
  });

  it("omits target for a tool_use with empty input (back-compat)", () => {
    const path = write([
      line("m1", toolUse("Bash"), { input_tokens: 5, output_tokens: 5 }),
    ]);
    const step = readTranscriptUsage(path)!.trace[0]!;
    expect("target" in step).toBe(false);
  });

  it("salts targets PER submission: same within a run, different across runs", () => {
    const path = write([
      line("m1", use("Bash", "b1", { command: "pytest tests/secret_a.py" }), { input_tokens: 5, output_tokens: 5 }),
      resultLine("b1", true),
      line("m2", use("Bash", "b2", { command: "pytest tests/secret_a.py" }), { input_tokens: 5, output_tokens: 5 }),
      resultLine("b2", true),
    ]);
    const run1 = readTranscriptUsage(path)!.trace;
    const run2 = readTranscriptUsage(path)!.trace;
    // Within ONE submission, the same command shares a target (server retry key).
    expect(run1[0]!.target).toBe(run1[1]!.target);
    // Across submissions the salt changes → the digest differs (a plain-hash
    // dictionary can't reverse it), while the cleartext program stays stable.
    expect(run1[0]!.target).not.toBe(run2[0]!.target);
    expect(run1[0]!.target!.startsWith("pytest ")).toBe(true);
    expect(run2[0]!.target!.startsWith("pytest ")).toBe(true);
  });
});

describe("readTranscriptUsage — tool-name allowlist (no custom MCP tool leaks)", () => {
  it("buckets a custom/internal MCP tool name to mcp:other, forwards host tools verbatim", () => {
    const path = write([
      line(
        "m1",
        use("mcp__acme-billing-internal__rotate_key", "t1", { foo: "bar" }),
        { input_tokens: 5, output_tokens: 5 },
      ),
    ]);
    const step = readTranscriptUsage(path)!.trace[0]!;
    expect(step.tool).toBe("mcp:other");
    // The org-identifying name never appears anywhere in the step.
    expect(JSON.stringify(step)).not.toContain("acme-billing-internal");

    // A known host tool is still forwarded exactly.
    const path2 = write([
      line("m2", use("Bash", "b1", { command: "pytest -q" }), { input_tokens: 1, output_tokens: 1 }),
    ]);
    expect(readTranscriptUsage(path2)!.trace[0]!.tool).toBe("Bash");
  });
});

describe("readTranscriptUsage — opt-out suppresses target", () => {
  it("drops every target but keeps tokens/kind/ok and the realized total", () => {
    const path = write([
      line("m1", use("Bash", "b1", { command: "pytest -q" }), { input_tokens: 100, output_tokens: 20 }),
      resultLine("b1", true),
    ]);
    const on = readTranscriptUsage(path, { target: true })!;
    const off = readTranscriptUsage(path, { target: false })!;

    expect(on.trace[0]!.target).toMatch(/^pytest /);
    expect("target" in off.trace[0]!).toBe(false); // suppressed
    expect(off.trace[0]!.ok).toBe(false); // ok retained — it carries no path/arg
    expect(off.trace[0]).toMatchObject({ tool: "Bash", tokens: 120 });
    expect({ tokensIn: off.tokensIn, tokensOut: off.tokensOut }).toEqual({
      tokensIn: 100,
      tokensOut: 20,
    });
  });

  it("defaults to including target when no option is given", () => {
    const path = write([
      line("m1", use("Bash", "b1", { command: "pytest" }), { input_tokens: 1, output_tokens: 1 }),
    ]);
    expect(readTranscriptUsage(path)!.trace[0]!.target).toMatch(/^pytest /);
  });
});
