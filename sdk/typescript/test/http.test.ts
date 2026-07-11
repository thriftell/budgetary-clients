import { describe, expect, it } from "vitest";

import {
  BudgetaryError,
  BudgetaryNetworkError,
} from "../src/index.js";
import { HttpClient, toCamelCase, toSnakeCase } from "../src/internal/http.js";

describe("toSnakeCase — protocol snake-cased, metadata verbatim", () => {
  it("snake-cases known keys but passes the free-form metadata map through untouched", () => {
    expect(
      toSnakeCase({
        estimateId: "e",
        tokensIn: 1,
        context: { projectId: "p", depthBudget: 2 },
        metadata: { toolCalls: 47, camelKey: "v", nested: { innerKey: 1 } },
      }),
    ).toEqual({
      estimate_id: "e",
      tokens_in: 1,
      context: { project_id: "p", depth_budget: 2 },
      metadata: { toolCalls: 47, camelKey: "v", nested: { innerKey: 1 } },
    });
  });
});

describe("toCamelCase — iterative, deep-nesting safe (P-C3)", () => {
  it("camelCases keys through nested objects and arrays", () => {
    expect(
      toCamelCase({
        estimate_id: "e",
        distribution: { p10: 1, unit: "tokens" },
        items: [{ inner_key: 1 }, { inner_key: 2 }],
      }),
    ).toEqual({
      estimateId: "e",
      distribution: { p10: 1, unit: "tokens" },
      items: [{ innerKey: 1 }, { innerKey: 2 }],
    });
  });

  it("passes primitives and null through unchanged", () => {
    expect(toCamelCase(5)).toBe(5);
    expect(toCamelCase(null)).toBeNull();
    expect(toCamelCase("s")).toBe("s");
  });

  it("does not blow the call stack on a deeply-nested body", () => {
    // A recursive walk would throw a raw RangeError here; the iterative walk
    // keeps the traversal on the heap. Build the depth without recursion.
    let deep: Record<string, unknown> = { leaf_key: 1 };
    for (let i = 0; i < 100_000; i++) deep = { nested_key: deep };
    expect(() => toCamelCase(deep)).not.toThrow();
  });
});

/** A minimal fetch double whose body read (`text()`) rejects. */
function fetchWithRejectingBody(err: unknown): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(err),
    })) as unknown as typeof fetch;
}

describe("HttpClient — a failed body read is classified, not raw", () => {
  function makeClient(fetchImpl: typeof fetch): HttpClient {
    return new HttpClient({
      apiKey: "k",
      baseUrl: "https://api.test.budgetary.tools",
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });
  }

  it("maps a rejecting response.text() to a BudgetaryNetworkError", async () => {
    const client = makeClient(
      fetchWithRejectingBody(new Error("socket hang up")),
    );
    const err = await client
      .request({ method: "GET", path: "/v1/health" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetaryError);
    expect(err).toBeInstanceOf(BudgetaryNetworkError);
  });

  it("maps a body-read timeout to a timeout network error", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const client = makeClient(fetchWithRejectingBody(timeout));
    const err = (await client
      .request({ method: "GET", path: "/v1/health" })
      .catch((e: unknown) => e)) as BudgetaryError;
    expect(err).toBeInstanceOf(BudgetaryNetworkError);
    expect(err.code).toBe("timeout");
  });
});

describe("mapNetworkError names the host + the underlying cause (O-6)", () => {
  function fetchThatThrows(err: unknown): typeof fetch {
    return (async () => {
      throw err;
    }) as unknown as typeof fetch;
  }
  function makeClient(fetchImpl: typeof fetch): HttpClient {
    return new HttpClient({
      apiKey: "k",
      baseUrl: "https://api.test.budgetary.tools",
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });
  }

  it("appends err.cause?.message and the target host (previously both dropped)", async () => {
    const fetchErr = new Error("fetch failed");
    (fetchErr as Error & { cause?: unknown }).cause = new Error(
      "connect ECONNREFUSED 127.0.0.1:9",
    );
    const client = makeClient(fetchThatThrows(fetchErr));
    const err = (await client
      .request({ method: "GET", path: "/v1/health" })
      .catch((e: unknown) => e)) as BudgetaryError;
    expect(err).toBeInstanceOf(BudgetaryNetworkError);
    // The host is named (host only — never the path/query)...
    expect(err.message).toContain("host: api.test.budgetary.tools");
    // ...and the real reason from err.cause is surfaced, not just "fetch failed".
    expect(err.message).toContain("connect ECONNREFUSED 127.0.0.1:9");
  });

  it("still works when there is no cause", async () => {
    const client = makeClient(fetchThatThrows(new Error("fetch failed")));
    const err = (await client
      .request({ method: "GET", path: "/v1/health" })
      .catch((e: unknown) => e)) as BudgetaryError;
    expect(err.message).toContain("host: api.test.budgetary.tools");
    expect(err.message).toContain("fetch failed");
  });
});
