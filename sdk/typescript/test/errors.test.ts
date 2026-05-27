import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  BudgetaryAuthError,
  BudgetaryClient,
  BudgetaryNotFoundError,
  BudgetaryRateLimitError,
  BudgetaryServerError,
  BudgetaryValidationError,
} from "../src/index.js";
import {
  TEST_API_KEY,
  TEST_BASE_URL,
  startTestServer,
} from "./fixtures/server.js";

const handle = startTestServer();

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

function errorBody(code: string, message: string, requestId = "req_test") {
  return {
    error: { code, message, request_id: requestId },
  };
}

interface ErrorCase {
  status: number;
  code: string;
  ctor: new (...args: never[]) => Error;
}

const cases: ErrorCase[] = [
  { status: 400, code: "invalid_request", ctor: BudgetaryValidationError },
  { status: 401, code: "authentication_failed", ctor: BudgetaryAuthError },
  { status: 403, code: "permission_denied", ctor: BudgetaryAuthError },
  { status: 404, code: "not_found", ctor: BudgetaryNotFoundError },
  { status: 409, code: "idempotency_conflict", ctor: BudgetaryValidationError },
  { status: 413, code: "payload_too_large", ctor: BudgetaryValidationError },
  { status: 500, code: "internal_error", ctor: BudgetaryServerError },
  { status: 503, code: "unavailable", ctor: BudgetaryServerError },
];

describe("HTTP status to error mapping", () => {
  for (const c of cases) {
    it(`HTTP ${c.status} → ${c.ctor.name} with code "${c.code}"`, async () => {
      handle.use(
        http.post(`${TEST_BASE_URL}/v1/estimate`, () =>
          HttpResponse.json(errorBody(c.code, "oops"), { status: c.status }),
        ),
      );
      const err = await client()
        .estimate("test", { clientRequestId: null })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(c.ctor);
      const e = err as InstanceType<typeof BudgetaryServerError>;
      expect(e.code).toBe(c.code);
      expect(e.httpStatus).toBe(c.status);
      expect(e.requestId).toBe("req_test");
    });
  }

  it("429 → BudgetaryRateLimitError with retryAfterSeconds from header", async () => {
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/estimate`, () =>
        HttpResponse.json(errorBody("rate_limited", "too many"), {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
      ),
    );

    const err = await client()
      .estimate("test", { clientRequestId: null })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BudgetaryRateLimitError);
    const rate = err as BudgetaryRateLimitError;
    expect(rate.code).toBe("rate_limited");
    expect(rate.httpStatus).toBe(429);
    expect(rate.retryAfterSeconds).toBe(7);
  });
});
