import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AutoActualsArgs } from "../src/actuals.js";
import {
  handleCallTool,
  parseOnSessionEndArgs,
  runOnSessionEndCli,
  SERVER_VERSION,
  TOOL_NAME,
} from "../src/server.js";
import type {
  EstimateToolArgs,
  EstimateToolResult,
} from "../src/tools/estimate.js";

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
  it("parses --transcript <path> and defaults success=true", () => {
    expect(parseOnSessionEndArgs(["--transcript", "/tmp/r.jsonl"])).toEqual({
      transcript: "/tmp/r.jsonl",
      success: true,
      error: null,
    });
  });

  it("accepts --rollout as an alias and a bare positional path", () => {
    expect(parseOnSessionEndArgs(["--rollout", "/tmp/r.jsonl"]).transcript).toBe(
      "/tmp/r.jsonl",
    );
    expect(parseOnSessionEndArgs(["/tmp/r.jsonl"])).toEqual({
      transcript: "/tmp/r.jsonl",
      success: true,
      error: null,
    });
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
      success: true,
      error: null,
    });
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
    expect(spy.calls[0]!.query).toBe("");
  });

  it("coerces a non-string model to undefined", async () => {
    const spy = estimateSpy({ text: "ok", isError: false });
    await handleCallTool(callRequest({ query: "q", model: 7 }), {
      runEstimate: spy.runEstimate,
    });
    expect(spy.calls[0]!.model).toBeUndefined();
  });

  it("passes a string query and model through unchanged", async () => {
    const spy = estimateSpy({ text: "ok", isError: false });
    await handleCallTool(callRequest({ query: "estimate this", model: "claude-x" }), {
      runEstimate: spy.runEstimate,
    });
    expect(spy.calls[0]!.query).toBe("estimate this");
    expect(spy.calls[0]!.model).toBe("claude-x");
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
    expect(auto.calls[0]!.payload).toEqual(payload);
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
    expect(auto.calls[0]!.payload).toBeNull();
    expect(errs.join("")).toBe("");
  });
});
