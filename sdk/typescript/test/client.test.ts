import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { BudgetaryClient } from "../src/index.js";
import {
  TEST_API_KEY,
  TEST_BASE_URL,
  jsonOk,
  startTestServer,
} from "./fixtures/server.js";

const handle = startTestServer();

beforeAll(() => handle.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => handle.reset());
afterAll(() => handle.server.close());

function newClient() {
  return new BudgetaryClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    maxRetries: 0,
  });
}

describe("BudgetaryClient.estimate", () => {
  it("POSTs snake_case body and parses camelCase response", async () => {
    handle.use(
      jsonOk("/v1/estimate", {
        estimate_id: "est_01ABC",
        scenario: "confident",
        void: false,
        distribution: { p10: 100, p50: 500, p90: 2000, unit: "tokens" },
        confidence: 0.8,
        model: "claude-opus-4-7",
        expires_at: "2026-05-27T10:14:00Z",
      }),
    );

    const client = newClient();
    const res = await client.estimate("write a haiku", {
      model: "claude-opus-4-7",
      context: { host: "sdk", projectId: "proj_x", depthBudget: 10 },
      clientRequestId: "req_fixed",
    });

    expect(res.estimateId).toBe("est_01ABC");
    expect(res.scenario).toBe("confident");
    expect(res.distribution).toEqual({
      p10: 100,
      p50: 500,
      p90: 2000,
      unit: "tokens",
    });
    expect(res.expiresAt).toBe("2026-05-27T10:14:00Z");

    expect(handle.requests).toHaveLength(1);
    const req = handle.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${TEST_BASE_URL}/v1/estimate`);
    expect(req.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(req.headers["content-type"]).toContain("application/json");
    expect(req.body).toEqual({
      query: "write a haiku",
      model: "claude-opus-4-7",
      context: { host: "sdk", project_id: "proj_x", depth_budget: 10 },
      client_request_id: "req_fixed",
    });
  });

  it("returns a void estimate without throwing", async () => {
    handle.use(
      jsonOk("/v1/estimate", {
        estimate_id: "est_02",
        scenario: "out_of_domain",
        void: true,
        distribution: null,
        confidence: 0,
        model: "claude-opus-4-7",
        expires_at: "2026-05-27T10:14:00Z",
      }),
    );

    const client = newClient();
    const res = await client.estimate("???", { clientRequestId: null });
    expect(res.void).toBe(true);
    expect(res.distribution).toBeNull();
  });
});

describe("BudgetaryClient.submitActuals", () => {
  it("POSTs to /v1/actuals and parses 202 response", async () => {
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/actuals`, () =>
        HttpResponse.json(
          { received: true, ledger_entry_id: "led_999" },
          { status: 202 },
        ),
      ),
    );

    const client = newClient();
    const res = await client.submitActuals({
      estimateId: "est_01ABC",
      tokensIn: 12340,
      tokensOut: 36210,
      success: true,
      durationMs: 420_000,
      metadata: { toolCalls: 47 },
    });

    expect(res).toEqual({ received: true, ledgerEntryId: "led_999" });

    const req = handle.requests[0]!;
    expect(req.body).toEqual({
      estimate_id: "est_01ABC",
      tokens_in: 12340,
      tokens_out: 36210,
      success: true,
      duration_ms: 420_000,
      metadata: { tool_calls: 47 },
    });
  });

  it("forwards the additive trace array verbatim on the wire", async () => {
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/actuals`, () =>
        HttpResponse.json(
          { received: true, ledger_entry_id: "led_trace" },
          { status: 202 },
        ),
      ),
    );

    const client = newClient();
    await client.submitActuals({
      estimateId: "est_01ABC",
      tokensIn: 100,
      tokensOut: 200,
      success: true,
      durationMs: 1000,
      trace: [
        { tool: "Read", tokens: 60 },
        { tool: "Bash", tokens: 20, kind: "turn-split" },
        { tool: "Edit", tokens: 20, kind: "turn-split" },
      ],
    });

    const req = handle.requests[0]!;
    // Step keys are already lowercase single words, so snake-casing is a no-op;
    // the trace must reach the server unchanged.
    expect(req.body).toEqual({
      estimate_id: "est_01ABC",
      tokens_in: 100,
      tokens_out: 200,
      success: true,
      duration_ms: 1000,
      trace: [
        { tool: "Read", tokens: 60 },
        { tool: "Bash", tokens: 20, kind: "turn-split" },
        { tool: "Edit", tokens: 20, kind: "turn-split" },
      ],
    });
  });

  it("forwards the additive change counts as snake_case integers (0023c)", async () => {
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/actuals`, () =>
        HttpResponse.json(
          { received: true, ledger_entry_id: "led_changes" },
          { status: 202 },
        ),
      ),
    );

    const client = newClient();
    await client.submitActuals({
      estimateId: "est_01ABC",
      tokensIn: 100,
      tokensOut: 200,
      success: true,
      durationMs: 1000,
      producedChanges: 5,
      acceptedChanges: 3,
    });

    const req = handle.requests[0]!;
    // The two integers reach the server as `produced_changes`/`accepted_changes`
    // — and nothing else: no path, diff, or content field is on the body.
    expect(req.body).toEqual({
      estimate_id: "est_01ABC",
      tokens_in: 100,
      tokens_out: 200,
      success: true,
      duration_ms: 1000,
      produced_changes: 5,
      accepted_changes: 3,
    });
  });
});

describe("BudgetaryClient.getLedger", () => {
  it("GETs /v1/ledger with snake_case query params and parses camelCase entries", async () => {
    handle.use(
      jsonOk("/v1/ledger", {
        entries: [
          {
            estimate_id: "est_01",
            created_at: "2026-05-26T03:14:00Z",
            query_excerpt: "fix the flaky test",
            model: "claude-opus-4-7",
            host: "claude-code",
            project_id: "proj_kx7",
            scenario: "confident",
            predicted: { p10: 100, p50: 500, p90: 2000 },
            actual: {
              tokens_in: 120,
              tokens_out: 380,
              total: 500,
              duration_ms: 9000,
              success: true,
            },
          },
        ],
        next_cursor: null,
      }),
    );

    const client = newClient();
    const page = await client.getLedger({
      projectId: "proj_kx7",
      host: "claude-code",
      limit: 50,
      includeOrphans: true,
    });

    expect(page.nextCursor).toBeNull();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.estimateId).toBe("est_01");
    expect(page.entries[0]!.actual?.tokensIn).toBe(120);

    const req = handle.requests[0]!;
    expect(req.method).toBe("GET");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/v1/ledger");
    expect(url.searchParams.get("project_id")).toBe("proj_kx7");
    expect(url.searchParams.get("host")).toBe("claude-code");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("include_orphans")).toBe("true");
  });
});

describe("BudgetaryClient base URL normalization", () => {
  it("strips trailing slashes from baseUrl without doubling the path", async () => {
    handle.use(
      jsonOk("/v1/estimate", {
        estimate_id: "est_slash",
        scenario: "confident",
        void: false,
        distribution: { p10: 1, p50: 2, p90: 3, unit: "tokens" },
        confidence: 0.5,
        model: "claude-opus-4-7",
        expires_at: "2026-05-27T10:14:00Z",
      }),
    );

    // A baseUrl with many trailing slashes is the ReDoS worst-case shape for
    // the old `/\/+$/`. With onUnhandledRequest:"error", a non-normalized URL
    // (e.g. ".../////v1/estimate") would fail to match the handler and throw.
    const client = new BudgetaryClient({
      apiKey: TEST_API_KEY,
      baseUrl: `${TEST_BASE_URL}/////`,
      maxRetries: 0,
    });

    const res = await client.estimate("normalize me");
    expect(res.estimateId).toBe("est_slash");

    expect(handle.requests).toHaveLength(1);
    expect(handle.requests[0]!.url).toBe(`${TEST_BASE_URL}/v1/estimate`);
  });
});
