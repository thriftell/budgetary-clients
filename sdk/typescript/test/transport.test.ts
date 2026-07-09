import { describe, expect, it } from "vitest";

import { BudgetaryClient, BudgetaryError } from "../src/index.js";

const KEY = "bg_test_dummy";
const OK_BODY = JSON.stringify({
  estimate_id: "est_1",
  scenario: "confident",
  void: false,
  distribution: { p10: 1, p50: 2, p90: 3, unit: "tokens" },
  confidence: 0.5,
  model: "m",
  expires_at: "2026-05-27T10:14:00Z",
});

const jsonResponse = (body: string, init?: ResponseInit): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    })) as unknown as typeof fetch;

describe("BudgetaryClient — baseUrl scheme safety (key never sent in cleartext)", () => {
  it("refuses a non-HTTPS, non-localhost baseUrl", () => {
    expect(
      () => new BudgetaryClient({ apiKey: KEY, baseUrl: "http://evil.example" }),
    ).toThrow(/non-HTTPS/i);
  });

  it("allows https, loopback http, and an explicit allowInsecure opt-in", () => {
    expect(
      () => new BudgetaryClient({ apiKey: KEY, baseUrl: "https://api.budgetary.tools" }),
    ).not.toThrow();
    expect(
      () => new BudgetaryClient({ apiKey: KEY, baseUrl: "http://localhost:8787" }),
    ).not.toThrow();
    expect(
      () => new BudgetaryClient({ apiKey: KEY, baseUrl: "http://127.0.0.1:3000" }),
    ).not.toThrow();
    expect(
      () =>
        new BudgetaryClient({
          apiKey: KEY,
          baseUrl: "http://staging.internal",
          allowInsecure: true,
        }),
    ).not.toThrow();
  });

  it("refuses a non-HTTP(S) scheme", () => {
    expect(
      () => new BudgetaryClient({ apiKey: KEY, baseUrl: "file:///etc/passwd" }),
    ).toThrow(/non-HTTPS/i);
  });

  it("defaults to the https API when no baseUrl is given", () => {
    expect(() => new BudgetaryClient({ apiKey: KEY })).not.toThrow();
  });
});

describe("HttpClient — refuses to follow redirects", () => {
  it("passes redirect:'error' to fetch (a 3xx never re-POSTs the body/key elsewhere)", async () => {
    let seen: RequestInit | undefined;
    const spy: typeof fetch = async (_url, init) => {
      seen = init as RequestInit;
      return new Response(OK_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new BudgetaryClient({
      apiKey: KEY,
      baseUrl: "https://api.test.budgetary.tools",
      fetchImpl: spy,
      maxRetries: 0,
    });
    await client.estimate("x", { clientRequestId: null });
    expect(seen?.redirect).toBe("error");
  });
});

describe("HttpClient — response body is size-capped", () => {
  function client(fetchImpl: typeof fetch): BudgetaryClient {
    return new BudgetaryClient({
      apiKey: KEY,
      baseUrl: "https://api.test.budgetary.tools",
      fetchImpl,
      maxRetries: 0,
    });
  }

  it("rejects up-front on an over-cap Content-Length", async () => {
    const c = client(
      jsonResponse("{}", {
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
    );
    await expect(c.estimate("x", { clientRequestId: null })).rejects.toThrow(
      /size limit/i,
    );
  });

  it("aborts a stream that exceeds the cap with no/lying Content-Length", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 10 * 1024 * 1024) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024 * 1024));
        sent += 1024 * 1024;
      },
    });
    const spy: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await expect(
      client(spy).estimate("x", { clientRequestId: null }),
    ).rejects.toBeInstanceOf(BudgetaryError);
  });

  it("still reads a normal (small) body fine", async () => {
    const res = await client(jsonResponse(OK_BODY)).estimate("x", {
      clientRequestId: null,
    });
    expect(res.estimateId).toBe("est_1");
  });

  it("rejects a non-finite number in a 2xx body (overflow literal → Infinity)", async () => {
    // `JSON.parse` turns the valid literal `1e400` into `Infinity`; it must not
    // reach the numeric response fields.
    const body =
      '{"estimate_id":"e","scenario":"confident","void":false,' +
      '"distribution":{"p10":1e400,"p50":1,"p90":2,"unit":"tokens"},' +
      '"confidence":0.5,"model":"m","expires_at":"t"}';
    await expect(
      client(jsonResponse(body)).estimate("x", { clientRequestId: null }),
    ).rejects.toThrow(/non-finite/i);
  });
});
