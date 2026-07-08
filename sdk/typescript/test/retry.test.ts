import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  BudgetaryClient,
  BudgetaryRateLimitError,
  BudgetaryServerError,
  BudgetaryValidationError,
} from "../src/index.js";
import { withRetry } from "../src/internal/retry.js";
import {
  TEST_API_KEY,
  TEST_BASE_URL,
  startTestServer,
} from "./fixtures/server.js";

const handle = startTestServer();

beforeAll(() => handle.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => handle.reset());
afterAll(() => handle.server.close());

describe("withRetry unit", () => {
  it("retries on BudgetaryServerError with exponential backoff", async () => {
    const sleeps: number[] = [];
    const calls: number[] = [];
    let attempt = 0;

    await withRetry(
      async () => {
        attempt += 1;
        calls.push(attempt);
        if (attempt < 4) {
          throw new BudgetaryServerError({
            code: "internal_error",
            message: "boom",
            httpStatus: 500,
            requestId: null,
          });
        }
        return "ok";
      },
      {
        maxRetries: 5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 1, // disable jitter so we can assert deterministically
      },
    );

    // 4 attempts → 3 sleeps with delays 1000, 2000, 4000 (factor 2).
    expect(calls).toEqual([1, 2, 3, 4]);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("honors Retry-After by waiting at least that many seconds on 429", async () => {
    const sleeps: number[] = [];
    let attempt = 0;

    await withRetry(
      async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new BudgetaryRateLimitError({
            code: "rate_limited",
            message: "slow down",
            httpStatus: 429,
            requestId: null,
            retryAfterSeconds: 2,
          });
        }
        return "ok";
      },
      {
        maxRetries: 3,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.01, // would give tiny jitter; Retry-After must dominate
      },
    );

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("clamps an oversized Retry-After to maxDelay (never hangs for minutes)", async () => {
    const sleeps: number[] = [];
    let attempt = 0;

    await withRetry(
      async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new BudgetaryRateLimitError({
            code: "rate_limited",
            message: "come back in an hour",
            httpStatus: 429,
            requestId: null,
            retryAfterSeconds: 3600, // 1 hour
          });
        }
        return "ok";
      },
      {
        maxRetries: 3,
        maxDelayMs: 5000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 1, // no jitter
      },
    );

    expect(sleeps).toHaveLength(1);
    // Clamped to maxDelay — NOT 3_600_000.
    expect(sleeps[0]).toBe(5000);
  });

  it("does not retry on non-retryable errors", async () => {
    let attempt = 0;
    const err = await withRetry(
      async () => {
        attempt += 1;
        throw new BudgetaryValidationError({
          code: "invalid_request",
          message: "nope",
          httpStatus: 400,
          requestId: null,
        });
      },
      { maxRetries: 5, sleep: async () => {}, random: () => 0 },
    ).catch((e: unknown) => e);

    expect(attempt).toBe(1);
    expect(err).toBeInstanceOf(BudgetaryValidationError);
  });

  it("caps total attempts at maxRetries + 1", async () => {
    let attempt = 0;
    const err = await withRetry(
      async () => {
        attempt += 1;
        throw new BudgetaryServerError({
          code: "internal_error",
          message: "boom",
          httpStatus: 500,
          requestId: null,
        });
      },
      { maxRetries: 2, sleep: async () => {}, random: () => 0 },
    ).catch((e: unknown) => e);

    expect(attempt).toBe(3);
    expect(err).toBeInstanceOf(BudgetaryServerError);
  });
});

describe("BudgetaryClient retry integration", () => {
  it("does not retry a 400", async () => {
    let calls = 0;
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/estimate`, () => {
        calls += 1;
        return HttpResponse.json(
          { error: { code: "invalid_request", message: "x", request_id: "r" } },
          { status: 400 },
        );
      }),
    );

    const client = new BudgetaryClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      maxRetries: 5,
    });

    await expect(
      client.estimate("hi", { clientRequestId: null }),
    ).rejects.toBeInstanceOf(BudgetaryValidationError);
    expect(calls).toBe(1);
  });

  it("retries a 503 and eventually succeeds within maxRetries", async () => {
    let calls = 0;
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/estimate`, () => {
        calls += 1;
        if (calls < 3) {
          return HttpResponse.json(
            { error: { code: "unavailable", message: "x", request_id: "r" } },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          estimate_id: "est_ok",
          scenario: "confident",
          void: false,
          distribution: { p10: 1, p50: 2, p90: 3, unit: "tokens" },
          confidence: 0.9,
          model: "claude-opus-4-7",
          expires_at: "2026-05-27T10:14:00Z",
        });
      }),
    );

    // Speed up retries by stubbing the sleep through a low maxRetries env.
    // We accept real delays here but keep them tiny by using maxRetries=2 and
    // letting the first retry's jittered delay (Math.random * 1000) elapse.
    // Total worst-case ≈ 3 s, well inside Vitest's default 5 s timeout.
    const client = new BudgetaryClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      maxRetries: 5,
    });

    const res = await client.estimate("hi", { clientRequestId: null });
    expect(res.estimateId).toBe("est_ok");
    expect(calls).toBe(3);
  }, 15_000);
});
