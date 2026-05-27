import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BudgetaryClient } from "../src/index.js";
import {
  TEST_API_KEY,
  TEST_BASE_URL,
  jsonOk,
  startTestServer,
} from "./fixtures/server.js";

const handle = startTestServer();

const okResponse = {
  estimate_id: "est_idem",
  scenario: "confident",
  void: false,
  distribution: { p10: 1, p50: 2, p90: 3, unit: "tokens" },
  confidence: 0.5,
  model: "claude-opus-4-7",
  expires_at: "2026-05-27T10:14:00Z",
};

beforeAll(() => handle.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => handle.reset());
afterAll(() => handle.server.close());

function client() {
  return new BudgetaryClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    maxRetries: 0,
  });
}

describe("clientRequestId behavior", () => {
  it("auto-generates a UUID when none is provided", async () => {
    handle.use(jsonOk("/v1/estimate", okResponse));

    await client().estimate("hello");

    const body = handle.requests[0]!.body as Record<string, unknown>;
    expect(typeof body.client_request_id).toBe("string");
    expect(body.client_request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("preserves a caller-supplied value", async () => {
    handle.use(jsonOk("/v1/estimate", okResponse));

    await client().estimate("hello", { clientRequestId: "req_explicit_1" });

    const body = handle.requests[0]!.body as Record<string, unknown>;
    expect(body.client_request_id).toBe("req_explicit_1");
  });

  it("omits the field entirely when null is passed", async () => {
    handle.use(jsonOk("/v1/estimate", okResponse));

    await client().estimate("hello", { clientRequestId: null });

    const body = handle.requests[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("client_request_id");
  });
});
