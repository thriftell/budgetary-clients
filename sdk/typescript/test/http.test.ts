import { describe, expect, it } from "vitest";

import {
  BudgetaryError,
  BudgetaryNetworkError,
} from "../src/index.js";
import { HttpClient, toSnakeCase } from "../src/internal/http.js";

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
