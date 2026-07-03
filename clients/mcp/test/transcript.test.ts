import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TRACE_MAX_BYTES,
  TRACE_MAX_STEPS,
  capTrace,
  collectPythonArtifacts,
  countChanges,
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

  it("is stable for identical operations and distinct for different args", () => {
    expect(redactBashTarget("pytest -q tests/")).toBe(redactBashTarget("pytest -q  tests/"));
    expect(redactBashTarget("pytest tests/a.py")).not.toBe(redactBashTarget("pytest tests/b.py"));
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
      expect(clear).not.toMatch(/[\/=]/);
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

  it("is stable per path (a retry key) and distinct across files", () => {
    expect(redactFileTarget("/a/b/c.ts")).toBe(redactFileTarget("/a/b/c.ts"));
    expect(redactFileTarget("/a/b/c.ts")).not.toBe(redactFileTarget("/a/b/d.ts"));
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

// ---------------------------------------------------------------------------
// Change accounting (0023c): two content-free integers measured off the same
// mutate-family events. produced = successful file-mutating calls (discrete
// events); accepted = those NOT superseded by a later edit to the same file.
// ---------------------------------------------------------------------------

describe("readTranscriptUsage — change counts (0023c)", () => {
  const U = { input_tokens: 5, output_tokens: 5 };

  it("counts distinct successful mutates as both produced and accepted", () => {
    const path = write([
      line("m1", use("Write", "w1", { file_path: "/repo/a.ts" }), U),
      resultLine("w1"), // file success: no is_error flag written
      line("m2", use("Edit", "e1", { file_path: "/repo/b.ts" }), U),
      resultLine("e1"),
    ]);
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 2, accepted: 2 });
  });

  it("decrements a change superseded by a later successful edit to the same file", () => {
    const path = write([
      line("m1", use("Edit", "e1", { file_path: "/repo/a.ts" }), U),
      resultLine("e1"),
      line("m2", use("Edit", "e2", { file_path: "/repo/a.ts" }), U),
      resultLine("e2"),
    ]);
    // Two produced, only the surviving last edit accepted (conservative).
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 2, accepted: 1 });
  });

  it("gives produced=N, accepted=N−M across survivors and superseded edits", () => {
    // file a: 3 successful mutates (2 superseded); file b: 1 → N=4, M=2, accepted=2.
    const path = write([
      line("m1", use("Edit", "a1", { file_path: "/repo/a.ts" }), U), resultLine("a1"),
      line("m2", use("Edit", "a2", { file_path: "/repo/a.ts" }), U), resultLine("a2"),
      line("m3", use("Write", "a3", { file_path: "/repo/a.ts" }), U), resultLine("a3"),
      line("m4", use("Edit", "b1", { file_path: "/repo/b.ts" }), U), resultLine("b1"),
    ]);
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 4, accepted: 2 });
  });

  it("excludes a failed (is_error) mutate from produced", () => {
    const path = write([
      line("m1", use("Edit", "e1", { file_path: "/repo/a.ts" }), U),
      resultLine("e1", true), // failed / denied edit → no change produced
      line("m2", use("Write", "w1", { file_path: "/repo/b.ts" }), U),
      resultLine("w1"),
    ]);
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 1, accepted: 1 });
  });

  it("does not count an unconfirmed mutate that has no tool_result", () => {
    const path = write([
      line("m1", use("Edit", "e1", { file_path: "/repo/a.ts" }), U),
      // no resultLine → success unconfirmed → conservative exclude
    ]);
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 0, accepted: 0 });
  });

  it("does not count a mutate whose tool_use carries no id (outcome unjoinable)", () => {
    const path = write([
      line(
        "m1",
        { type: "tool_use", name: "Edit", input: { file_path: "/repo/a.ts" } },
        U,
      ),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    ]);
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 0, accepted: 0 });
  });

  it("counts a successful mutate with no derivable target as produced but not accepted", () => {
    const path = write([
      line("m1", toolUse("Edit"), U), // input {} → no file_path
      resultLine("tu"), // succeeds, but survival is undeterminable without a target
    ]);
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 1, accepted: 0 });
  });

  it("ignores non-mutating tools (Read / Bash / Grep)", () => {
    const path = write([
      line("m1", use("Read", "r1", { file_path: "/repo/a.ts" }), U), resultLine("r1"),
      line("m2", use("Bash", "b1", { command: "pytest -q" }), U), resultLine("b1", false),
    ]);
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 0, accepted: 0 });
  });

  it("reports an edit-free session as an honest { 0, 0 }", () => {
    const path = write([line("m1", text, { input_tokens: 2, output_tokens: 500 })]);
    expect(readTranscriptUsage(path)!.changes).toEqual({ produced: 0, accepted: 0 });
  });

  it("measures identical counts regardless of the target opt-out (counts are not redacted)", () => {
    const path = write([
      line("m1", use("Edit", "e1", { file_path: "/repo/a.ts" }), U), resultLine("e1"),
      line("m2", use("Edit", "e2", { file_path: "/repo/a.ts" }), U), resultLine("e2"),
    ]);
    const on = readTranscriptUsage(path, { target: true })!.changes;
    const off = readTranscriptUsage(path, { target: false })!.changes;
    expect(on).toEqual({ produced: 2, accepted: 1 });
    expect(off).toEqual(on);
  });
});

describe("countChanges — pure function contract", () => {
  type Use = { name: string; id: string | null; input: Record<string, unknown> | null };
  // Mirror readTranscriptUsage's two structures: `resultIds` = every result
  // present; `results` = only the boolean is_error (true = failed).
  function count(tools: Use[], failedIds: string[] = [], noResultIds: string[] = []) {
    const resultIds = new Set<string>();
    const results = new Map<string, boolean>();
    for (const t of tools) {
      if (t.id === null || noResultIds.includes(t.id)) continue;
      resultIds.add(t.id);
      if (failedIds.includes(t.id)) results.set(t.id, true);
    }
    return countChanges(tools as never, results, resultIds);
  }
  const edit = (id: string | null, file: string | null): Use => ({
    name: "Edit",
    id,
    input: file === null ? {} : { file_path: file },
  });

  it("guarantees 0 <= accepted <= produced", () => {
    const r = count([edit("1", "/a"), edit("2", "/a"), edit("3", "/b")]);
    expect(r).toEqual({ produced: 3, accepted: 2 });
    expect(r.accepted).toBeLessThanOrEqual(r.produced);
    expect(r.accepted).toBeGreaterThanOrEqual(0);
  });

  it("never counts a non-mutate tool", () => {
    const r = count([
      { name: "Read", id: "1", input: { file_path: "/a" } },
      { name: "Bash", id: "2", input: { command: "ls" } },
    ]);
    expect(r).toEqual({ produced: 0, accepted: 0 });
  });

  it("excludes a failed mutate and a result-less mutate from produced", () => {
    // 1 failed, 2 has no result, 3 succeeds → produced=1, accepted=1.
    const r = count([edit("1", "/a"), edit("2", "/b"), edit("3", "/c")], ["1"], ["2"]);
    expect(r).toEqual({ produced: 1, accepted: 1 });
  });

  it("treats an id-less success as unconfirmed and a targetless success as produced-not-accepted", () => {
    const r = count([edit(null, "/a"), edit("2", null)]);
    expect(r).toEqual({ produced: 1, accepted: 0 });
  });
});

// ---------------------------------------------------------------------------
// Produced-Python artifact collection (0023e): the local-only path list the
// static resolver reads. Same confirmed-success detection as change counts;
// Python-first; deduped; raw paths (never forwarded — only counts are).
// ---------------------------------------------------------------------------

describe("readTranscriptUsage — pythonArtifacts (0023e)", () => {
  const U = { input_tokens: 5, output_tokens: 5 };

  it("collects distinct successful .py mutate targets", () => {
    const path = write([
      line("m1", use("Write", "w1", { file_path: "/repo/a.py" }), U), resultLine("w1"),
      line("m2", use("Edit", "e1", { file_path: "/repo/pkg/b.py" }), U), resultLine("e1"),
    ]);
    expect(readTranscriptUsage(path)!.pythonArtifacts).toEqual([
      "/repo/a.py",
      "/repo/pkg/b.py",
    ]);
  });

  it("dedupes repeated edits to the same .py file", () => {
    const path = write([
      line("m1", use("Edit", "e1", { file_path: "/repo/a.py" }), U), resultLine("e1"),
      line("m2", use("Edit", "e2", { file_path: "/repo/a.py" }), U), resultLine("e2"),
    ]);
    expect(readTranscriptUsage(path)!.pythonArtifacts).toEqual(["/repo/a.py"]);
  });

  it("excludes non-Python targets (Python-first)", () => {
    const path = write([
      line("m1", use("Write", "w1", { file_path: "/repo/a.ts" }), U), resultLine("w1"),
      line("m2", use("Write", "w2", { file_path: "/repo/README.md" }), U), resultLine("w2"),
      line("m3", use("Write", "w3", { file_path: "/repo/keep.py" }), U), resultLine("w3"),
    ]);
    expect(readTranscriptUsage(path)!.pythonArtifacts).toEqual(["/repo/keep.py"]);
  });

  it("excludes a failed or unconfirmed .py mutate", () => {
    const path = write([
      line("m1", use("Edit", "e1", { file_path: "/repo/failed.py" }), U), resultLine("e1", true),
      line("m2", use("Edit", "e2", { file_path: "/repo/noresult.py" }), U), // no result
      line("m3", use("Write", "w1", { file_path: "/repo/ok.py" }), U), resultLine("w1"),
    ]);
    expect(readTranscriptUsage(path)!.pythonArtifacts).toEqual(["/repo/ok.py"]);
  });

  it("ignores a Python path read by a non-mutating tool", () => {
    const path = write([
      line("m1", use("Read", "r1", { file_path: "/repo/a.py" }), U), resultLine("r1"),
    ]);
    expect(readTranscriptUsage(path)!.pythonArtifacts).toEqual([]);
  });

  it("is empty for an edit-free session", () => {
    const path = write([line("m1", text, { input_tokens: 2, output_tokens: 9 })]);
    expect(readTranscriptUsage(path)!.pythonArtifacts).toEqual([]);
  });
});

describe("collectPythonArtifacts — pure function contract", () => {
  type Use = { name: string; id: string | null; input: Record<string, unknown> | null };
  function collect(tools: Use[], failedIds: string[] = [], noResultIds: string[] = []) {
    const resultIds = new Set<string>();
    const results = new Map<string, boolean>();
    for (const t of tools) {
      if (t.id === null || noResultIds.includes(t.id)) continue;
      resultIds.add(t.id);
      if (failedIds.includes(t.id)) results.set(t.id, true);
    }
    return collectPythonArtifacts(tools as never, results, resultIds);
  }
  const write_ = (id: string | null, file: string | null): Use => ({
    name: "Write",
    id,
    input: file === null ? {} : { file_path: file },
  });

  it("returns only distinct successful .py targets, in first-seen order", () => {
    expect(
      collect([write_("1", "/a.py"), write_("2", "/b.py"), write_("3", "/a.py")]),
    ).toEqual(["/a.py", "/b.py"]);
  });

  it("drops a targetless success (no path to read)", () => {
    expect(collect([write_("1", null), write_("2", "/keep.py")])).toEqual(["/keep.py"]);
  });

  it("drops failed and result-less mutates", () => {
    expect(
      collect([write_("1", "/x.py"), write_("2", "/y.py"), write_("3", "/z.py")], ["1"], ["2"]),
    ).toEqual(["/z.py"]);
  });

  it("reads notebook_path and path fields too, but still only .py", () => {
    expect(
      collect([
        { name: "Write", id: "1", input: { path: "/via-path.py" } },
        { name: "MultiEdit", id: "2", input: { file_path: "/multi.py" } },
        { name: "Write", id: "3", input: { notebook_path: "/nb.ipynb" } },
      ]),
    ).toEqual(["/via-path.py", "/multi.py"]);
  });
});
