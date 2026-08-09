import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AutoActualsArgs } from "../src/actuals.js";
import {
  handleCallTool,
  main,
  parseOnSessionEndArgs,
  parseReportActualArgs,
  runOnSessionEndCli,
  runStdioServer,
  SERVER_VERSION,
  TOOL_NAME,
} from "../src/server.js";
import type {
  EstimateToolArgs,
  EstimateToolResult,
} from "../src/tools/estimate.js";

// Read the sole recorded call without a non-null assertion: noUncheckedIndexedAccess
// types `arr[0]` as `T | undefined`, so narrow it with a guard (like `firstText`).
function firstCall<T>(calls: readonly T[]): T {
  const first = calls[0];
  if (first === undefined) {
    throw new Error("expected the injected runner to have been called");
  }
  return first;
}

describe("SERVER_VERSION", () => {
  it("is derived from package.json, not a hard-coded 0.0.0", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).not.toBe("0.0.0");
  });
});

describe("parseOnSessionEndArgs", () => {
  it("★ parses --transcript <path> and declares NO outcome without a flag", () => {
    // Was `success: true`. A harness that passed neither flag declared
    // nothing, and a default of `true` recorded an unmeasured success on every
    // flag-less invocation — permanently, since only the first submission for
    // an estimate is stored. Absence of a flag is now absence of a value.
    expect(parseOnSessionEndArgs(["--transcript", "/tmp/r.jsonl"])).toEqual({
      transcript: "/tmp/r.jsonl",
      success: null,
      censoring: null,
      error: null,
    });
  });

  it("accepts --rollout as an alias and a bare positional path", () => {
    expect(parseOnSessionEndArgs(["--rollout", "/tmp/r.jsonl"]).transcript).toBe(
      "/tmp/r.jsonl",
    );
    expect(parseOnSessionEndArgs(["/tmp/r.jsonl"])).toEqual({
      transcript: "/tmp/r.jsonl",
      success: null,
      censoring: null,
      error: null,
    });
  });

  it("★ --success declares true explicitly, and the last flag wins", () => {
    // The flags are the one honest producer of this field: a harness invoking
    // this subcommand is declaring what its own oracle measured. Both remain
    // parsed exactly as before — only their ABSENCE changed meaning.
    expect(
      parseOnSessionEndArgs(["--success", "--transcript", "/tmp/r.jsonl"]).success,
    ).toBe(true);
    expect(
      parseOnSessionEndArgs(["--transcript", "/tmp/r.jsonl", "--success"]).success,
    ).toBe(true);
    expect(parseOnSessionEndArgs(["--success", "--failed"]).success).toBe(false);
    expect(parseOnSessionEndArgs(["--failed", "--success"]).success).toBe(true);
  });

  it("--failed sets success=false regardless of order", () => {
    expect(
      parseOnSessionEndArgs(["--failed", "--transcript", "/tmp/r.jsonl"]).success,
    ).toBe(false);
    expect(
      parseOnSessionEndArgs(["--transcript", "/tmp/r.jsonl", "--failed"]).success,
    ).toBe(false);
  });

  it("errors when --transcript has no value (never a silent hook fall-through)", () => {
    const r = parseOnSessionEndArgs(["--transcript"]);
    expect(r.transcript).toBeNull();
    expect(r.error).toMatch(/requires a file path/);
  });

  it("errors instead of swallowing a flag-shaped value (--transcript --failed)", () => {
    const r = parseOnSessionEndArgs(["--transcript", "--failed"]);
    // The intent to submit is not silently reinterpreted as a file named --failed.
    expect(r.transcript).toBeNull();
    expect(r.error).toMatch(/requires a file path/);
  });

  it("no args → hook path (no transcript, no error)", () => {
    expect(parseOnSessionEndArgs([])).toEqual({
      transcript: null,
      success: null,
      censoring: null,
      error: null,
    });
  });
});

describe("parseOnSessionEndArgs — --censoring (0099a-1)", () => {
  it("parses --censoring <value> in every position relative to the transcript", () => {
    for (const rest of [
      ["--censoring", "natural", "--transcript", "/tmp/r.jsonl"],
      ["--transcript", "/tmp/r.jsonl", "--censoring", "natural"],
      ["--censoring", "natural", "/tmp/r.jsonl"],
      ["/tmp/r.jsonl", "--censoring", "natural"],
      ["--failed", "--censoring", "natural", "--transcript", "/tmp/r.jsonl"],
    ]) {
      const r = parseOnSessionEndArgs(rest);
      expect(r.transcript).toBe("/tmp/r.jsonl");
      expect(r.censoring).toBe("natural");
      expect(r.error).toBeNull();
    }
  });

  it("★ never claims the flag's value as the bare-positional transcript path", () => {
    // The loop's bare-positional branch takes the first non-flag token when no
    // transcript is set yet, and unrecognised flags are silently ignored — so a
    // `--censoring` handled OUTSIDE the loop would have its value swallowed as
    // the path. Pin the consumption: the value token is consumed in every
    // order, and even when it is not a valid category (validation is
    // downstream, fail-closed to omission — the syntax must still not leak it).
    expect(parseOnSessionEndArgs(["--censoring", "natural"]).transcript).toBeNull();
    expect(
      parseOnSessionEndArgs(["--censoring", "natural", "/tmp/r.jsonl"]).transcript,
    ).toBe("/tmp/r.jsonl");
    expect(
      parseOnSessionEndArgs(["--censoring", "Natural", "/tmp/r.jsonl"]).transcript,
    ).toBe("/tmp/r.jsonl");
    // Even a value that LOOKS like a path is the flag's value, not the transcript.
    expect(
      parseOnSessionEndArgs([
        "--censoring",
        "/tmp/decoy.jsonl",
        "--transcript",
        "/tmp/r.jsonl",
      ]).transcript,
    ).toBe("/tmp/r.jsonl");
  });

  it("passes the raw value through — exact-match-or-omit happens downstream, never here", () => {
    // The parser is syntax only: a near-miss is NOT normalized into a category
    // (and not errored); the submit path drops it from the body.
    expect(
      parseOnSessionEndArgs(["--censoring", "Natural", "/tmp/r.jsonl"]).censoring,
    ).toBe("Natural");
  });

  it("a missing or flag-shaped value leaves the declaration null — not an error", () => {
    const dangling = parseOnSessionEndArgs(["--transcript", "/tmp/r.jsonl", "--censoring"]);
    expect(dangling.censoring).toBeNull();
    expect(dangling.error).toBeNull();
    const flagShaped = parseOnSessionEndArgs([
      "--censoring",
      "--failed",
      "--transcript",
      "/tmp/r.jsonl",
    ]);
    expect(flagShaped.censoring).toBeNull();
    expect(flagShaped.success).toBe(false); // --failed still parsed as itself
    expect(flagShaped.error).toBeNull();
  });

  it("★★ the stdin hook form IGNORES --censoring: nothing derived from it reaches the auto path", async () => {
    // The hook path's payload `reason` is session-scoped; `--censoring` is a
    // run-scoped declaration aimed at the --transcript form. The two share a
    // subcommand and must not be conflated: the auto path's argument surface
    // carries no censoring at all, so the flag cannot even be forwarded.
    const calls: AutoActualsArgs[] = [];
    const stderrLines: string[] = [];
    const code = await runOnSessionEndCli(["--censoring", "kill_switch"], {
      stdin: (async function* () {
        yield JSON.stringify({ reason: "clear", transcript_path: "/tmp/t.jsonl" });
      })(),
      stderr: { write: (s) => stderrLines.push(s) },
      env: {} as NodeJS.ProcessEnv,
      runAuto: async (a) => {
        calls.push(a);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(firstCall(calls))).not.toContain("censoring");
    // The declaration went nowhere, and that is SAID rather than silent: a
    // caller that forgot --transcript would otherwise lose it with exit 0 and
    // no signal anywhere. (Still a note, never an error — this is also the
    // path a miswired hook takes, and the hook must fail closed.)
    expect(stderrLines.join("")).toContain(
      "--censoring only applies to the --transcript form; ignoring it here.",
    );
  });

  it("no note when the hook form carries no --censoring (stderr stays silent)", async () => {
    const stderrLines: string[] = [];
    const code = await runOnSessionEndCli([], {
      stdin: (async function* () {
        yield JSON.stringify({ reason: "clear" });
      })(),
      stderr: { write: (s) => stderrLines.push(s) },
      env: {} as NodeJS.ProcessEnv,
      runAuto: async () => 0,
    });
    expect(code).toBe(0);
    expect(stderrLines.join("")).not.toContain("--censoring");
  });
});

describe("handleCallTool", () => {
  // A stand-in estimate tool that records the args it was called with and
  // returns a canned result, so the handler's dispatch + argument coercion can
  // be asserted without a live SDK client or network.
  function estimateSpy(result: EstimateToolResult) {
    const calls: EstimateToolArgs[] = [];
    const runEstimate = async (
      args: EstimateToolArgs,
    ): Promise<EstimateToolResult> => {
      calls.push(args);
      return result;
    };
    return { calls, runEstimate };
  }

  function callRequest(
    args: Record<string, unknown>,
    name: string = TOOL_NAME,
  ): CallToolRequest {
    return { method: "tools/call", params: { name, arguments: args } };
  }

  // The result content is a union; narrow to the text block to read `.text`.
  function firstText(
    result: Awaited<ReturnType<typeof handleCallTool>>,
  ): string {
    const first = result.content[0];
    if (!first || first.type !== "text") {
      throw new Error("expected a text content block");
    }
    return first.text;
  }

  it("rejects an unknown tool as an isError result without running the estimate", async () => {
    const spy = estimateSpy({ text: "unused", isError: false });
    const result = await handleCallTool(callRequest({}, "not_a_tool"), {
      runEstimate: spy.runEstimate,
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Unknown tool");
    expect(firstText(result)).toContain("not_a_tool");
    expect(spy.calls).toHaveLength(0);
  });

  it("coerces a non-string query to an empty string before the tool sees it", async () => {
    const spy = estimateSpy({ text: "ok", isError: false });
    await handleCallTool(callRequest({ query: 123 }), {
      runEstimate: spy.runEstimate,
    });
    expect(spy.calls).toHaveLength(1);
    expect(firstCall(spy.calls).query).toBe("");
  });

  it("coerces a non-string model to undefined", async () => {
    const spy = estimateSpy({ text: "ok", isError: false });
    await handleCallTool(callRequest({ query: "q", model: 7 }), {
      runEstimate: spy.runEstimate,
    });
    expect(firstCall(spy.calls).model).toBeUndefined();
  });

  it("passes a string query and model through unchanged", async () => {
    const spy = estimateSpy({ text: "ok", isError: false });
    await handleCallTool(callRequest({ query: "estimate this", model: "claude-x" }), {
      runEstimate: spy.runEstimate,
    });
    expect(firstCall(spy.calls).query).toBe("estimate this");
    expect(firstCall(spy.calls).model).toBe("claude-x");
  });

  it("forwards the host cancellation signal to the estimate tool (R-2)", async () => {
    const spy = estimateSpy({ text: "ok", isError: false });
    const controller = new AbortController();
    await handleCallTool(callRequest({ query: "q" }), {
      runEstimate: spy.runEstimate,
      signal: controller.signal,
    });
    // The tool receives the same AbortSignal buildServer takes from extra.signal,
    // so an abandoned estimate can stop retrying against a struggling engine.
    expect(firstCall(spy.calls).signal).toBe(controller.signal);
  });

  it("maps the tool result's text and isError through to the MCP content", async () => {
    const spy = estimateSpy({ text: "the rendered estimate", isError: true });
    const result = await handleCallTool(callRequest({ query: "q" }), {
      runEstimate: spy.runEstimate,
    });
    expect(firstText(result)).toBe("the rendered estimate");
    expect(result.isError).toBe(true);
  });
});

describe("runOnSessionEndCli (stdin hook path)", () => {
  async function* streamOf(...chunks: string[]): AsyncGenerator<string> {
    for (const chunk of chunks) yield chunk;
  }

  // Records the args routed to the auto-actuals runner (whose own behavior is
  // covered by the runAutoActuals tests) so this suite can assert only how the
  // CLI parses stdin and dispatches — no store or network involved.
  function autoSpy() {
    const calls: AutoActualsArgs[] = [];
    const runAuto = async (args: AutoActualsArgs): Promise<number> => {
      calls.push(args);
      return 0;
    };
    return { calls, runAuto };
  }

  it("routes a JSON session-end payload on stdin to the auto path", async () => {
    const auto = autoSpy();
    const errs: string[] = [];
    const payload = {
      transcript_path: "/tmp/rollout.jsonl",
      reason: "clear",
      cwd: "/w",
    };
    const code = await runOnSessionEndCli([], {
      stdin: streamOf(JSON.stringify(payload)),
      stderr: { write: (s: string) => { errs.push(s); } },
      env: {},
      runAuto: auto.runAuto,
    });
    expect(code).toBe(0);
    expect(auto.calls).toHaveLength(1);
    expect(firstCall(auto.calls).payload).toEqual(payload);
    expect(errs.join("")).toBe(""); // silent on a valid payload
  });

  it("prints the --transcript guidance and exits 0 on non-JSON stdin (never auto)", async () => {
    const auto = autoSpy();
    const errs: string[] = [];
    const code = await runOnSessionEndCli([], {
      stdin: streamOf("this is a raw rollout, not a JSON envelope\n"),
      stderr: { write: (s: string) => { errs.push(s); } },
      env: {},
      runAuto: auto.runAuto,
    });
    expect(code).toBe(0);
    expect(auto.calls).toHaveLength(0);
    expect(errs.join("")).toContain("--transcript");
  });

  it("routes empty stdin to the auto path with a null payload", async () => {
    const auto = autoSpy();
    const errs: string[] = [];
    const code = await runOnSessionEndCli([], {
      stdin: streamOf(""),
      stderr: { write: (s: string) => { errs.push(s); } },
      env: {},
      runAuto: auto.runAuto,
    });
    expect(code).toBe(0);
    expect(auto.calls).toHaveLength(1);
    expect(firstCall(auto.calls).payload).toBeNull();
    expect(errs.join("")).toBe("");
  });

  it("fails closed (exit 0) with a clean stderr line when the auto path throws", async () => {
    // The hook's contract is exit 0 whatever happens; an unforeseen throw from
    // the auto path must be caught and reported, never a raw stack that crashes
    // the host or a non-zero exit that reads as a retryable failure.
    const errs: string[] = [];
    const code = await runOnSessionEndCli([], {
      stdin: streamOf(
        JSON.stringify({ transcript_path: "/tmp/t.jsonl", reason: "clear", cwd: "/w" }),
      ),
      stderr: { write: (s: string) => { errs.push(s); } },
      env: {},
      runAuto: async () => {
        throw new Error("boom from the store");
      },
    });
    expect(code).toBe(0);
    const text = errs.join("");
    expect(text).toContain("unexpected error");
    expect(text).toContain("boom from the store"); // the cause, not a swallowed error
  });

  it("fails closed (exit 0, no auto) when stdin exceeds the size cap", async () => {
    const auto = autoSpy();
    const errs: string[] = [];
    const oneMb = "x".repeat(1024 * 1024);
    // 9 MiB of stdin exceeds the 8 MiB cap; the read is bounded and fails closed.
    const code = await runOnSessionEndCli([], {
      stdin: streamOf(...Array.from({ length: 9 }, () => oneMb)),
      stderr: { write: (s: string) => { errs.push(s); } },
      env: {},
      runAuto: auto.runAuto,
    });
    expect(code).toBe(0);
    expect(auto.calls).toHaveLength(0); // never dispatched to the auto path
    expect(errs.join("")).toContain("size limit");
  });
});

// ---------------------------------------------------------------------------
// PR-2: main() dispatch — no argument silently blocks on the server; every other
// token gets a real answer. (The argv-less server path is not exercised here —
// it would block on stdin — but every non-server branch is.)
// ---------------------------------------------------------------------------

describe("main — subcommand dispatch never silently starts the server", () => {
  // Capture process stdout/stderr without printing during the test run.
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    const se = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    });
    return { out, err, restore: () => { so.mockRestore(); se.mockRestore(); } };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--version prints the version to stdout and exits 0 (never the server)", async () => {
    const cap = capture();
    const code = await main(["--version"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out.join("")).toContain(SERVER_VERSION);
  });

  it("-v and `version` are aliases", async () => {
    for (const arg of ["-v", "version"]) {
      const cap = capture();
      const code = await main([arg]);
      cap.restore();
      expect(code).toBe(0);
      expect(cap.out.join("")).toContain(SERVER_VERSION);
    }
  });

  it("--help / -h / help print usage to stdout and exit 0", async () => {
    for (const arg of ["--help", "-h", "help"]) {
      const cap = capture();
      const code = await main([arg]);
      cap.restore();
      expect(code).toBe(0);
      expect(cap.out.join("")).toContain("Usage:");
      expect(cap.out.join("")).toContain("doctor");
    }
  });

  it("an unknown subcommand prints usage to STDERR and exits 2 (never the server)", async () => {
    const cap = capture();
    const code = await main(["definitely-not-a-command"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain('unknown subcommand "definitely-not-a-command"');
    expect(cap.err.join("")).toContain("Usage:");
    // The usage text is the answer — it never fell through to stdout/server.
    expect(cap.out.join("")).toBe("");
  });
});

describe("runStdioServer — readiness banner goes to STDERR, never stdout", () => {
  it("writes the version banner to stderr and NOTHING to stdout (JSON-RPC channel)", async () => {
    // Inject a no-op connect so no real stdio transport is stood up; capture the
    // injected stderr and spy on process.stdout to prove the channel stays clean.
    const err: string[] = [];
    const so = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runStdioServer({
      connect: async () => {},
      stderr: { write: (s: string) => { err.push(s); } },
    });
    so.mockRestore();
    expect(err.join("")).toContain(`Budgetary MCP server v${SERVER_VERSION} ready`);
    // stdout is reserved for the MCP transport's JSON-RPC — the banner must not
    // have gone there.
    expect(so).not.toHaveBeenCalled();
  });

  it("names the key TIER on the banner (free vs paid), never the value", async () => {
    const saved = process.env.BUDGETARY_API_KEY;
    process.env.BUDGETARY_API_KEY = "bg_test_bannerkey";
    try {
      const err: string[] = [];
      const so = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runStdioServer({
        connect: async () => {},
        stderr: { write: (s: string) => { err.push(s); } },
      });
      so.mockRestore();
      const banner = err.join("");
      expect(banner).toContain("key: bg_test_ (free)");
      // Never the value.
      expect(banner).not.toContain("bg_test_bannerkey");
    } finally {
      if (saved === undefined) delete process.env.BUDGETARY_API_KEY;
      else process.env.BUDGETARY_API_KEY = saved;
    }
  });
});

describe("parseReportActualArgs", () => {
  it("extracts --estimate-id <id>", () => {
    expect(parseReportActualArgs(["--estimate-id", "est_abc"])).toEqual({
      estimateId: "est_abc",
    });
  });
  it("returns null when absent, or when the flag has no (non-flag) value", () => {
    expect(parseReportActualArgs([])).toEqual({ estimateId: null });
    expect(parseReportActualArgs(["--estimate-id"])).toEqual({ estimateId: null });
    expect(parseReportActualArgs(["--estimate-id", "--failed"])).toEqual({
      estimateId: null,
    });
  });
});
