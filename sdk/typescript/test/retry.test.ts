import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { delay, http, HttpResponse } from "msw";
import {
  BudgetaryClient,
  BudgetaryError,
  BudgetaryNetworkError,
  BudgetaryRateLimitError,
  BudgetaryServerError,
  BudgetaryValidationError,
} from "../src/index.js";
import { withRetry, type RetryInfo } from "../src/internal/retry.js";
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

  it("fails fast when Retry-After exceeds the max backoff (never retries before the server's stated time)", async () => {
    const sleeps: number[] = [];
    let attempt = 0;

    const err = await withRetry(
      async () => {
        attempt += 1;
        throw new BudgetaryRateLimitError({
          code: "rate_limited",
          message: "come back in an hour",
          httpStatus: 429,
          requestId: null,
          retryAfterSeconds: 3600, // 1 hour ≫ maxDelay
        });
      },
      {
        maxRetries: 3,
        maxDelayMs: 5000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 1, // no jitter
      },
    ).catch((e: unknown) => e);

    // Retry-After (3_600_000 ms) > maxDelay (5000 ms): sleeping the clamped 5 s
    // and retrying would fire long before the server said success is possible.
    // So we DON'T sleep and DON'T retry — we surface the rate-limit error with
    // Retry-After intact so the caller can honor the full wait.
    expect(attempt).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(err).toBeInstanceOf(BudgetaryRateLimitError);
    expect((err as BudgetaryRateLimitError).retryAfterSeconds).toBe(3600);
    // Annotated on the terminal throw like any exhausted/non-retryable error.
    expect((err as BudgetaryError).attempts).toBe(1);
  });

  it("still retries a Retry-After that fits within maxDelay", async () => {
    // Guard the boundary from the other side: a wait AT/UNDER maxDelay is honored
    // by sleeping (the floor), not by failing fast.
    const sleeps: number[] = [];
    let attempt = 0;
    const res = await withRetry(
      async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new BudgetaryRateLimitError({
            code: "rate_limited",
            message: "brief",
            httpStatus: 429,
            requestId: null,
            retryAfterSeconds: 3, // 3000 ms <= maxDelay
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
        random: () => 0, // no jitter → delay is exactly the 3000 ms floor
      },
    );
    expect(res).toBe("ok");
    expect(attempt).toBe(2);
    expect(sleeps).toEqual([3000]);
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

describe("withRetry — attempts / totalElapsedMs / onRetry (O-6)", () => {
  // A shared fake clock so totalElapsedMs is deterministic: sleep advances it.
  function fakeClock() {
    let ms = 0;
    return {
      now: () => ms,
      sleep: async (d: number) => {
        ms += d;
      },
    };
  }

  it("annotates the error with attempts + totalElapsedMs on EXHAUSTION", async () => {
    const clk = fakeClock();
    const err = await withRetry(
      async () => {
        throw new BudgetaryServerError({ code: "internal_error", message: "boom", httpStatus: 500, requestId: null });
      },
      { maxRetries: 2, sleep: clk.sleep, now: clk.now, random: () => 1 },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BudgetaryServerError);
    // 3 total attempts (initial + 2 retries).
    expect((err as BudgetaryError).attempts).toBe(3);
    // 2 sleeps: 1000 + 2000 (factor 2, no jitter).
    expect((err as BudgetaryError).totalElapsedMs).toBe(3000);
  });

  it("annotates a non-retryable error with attempts = 1", async () => {
    const err = await withRetry(
      async () => {
        throw new BudgetaryValidationError({ code: "invalid_request", message: "nope", httpStatus: 400, requestId: null });
      },
      { maxRetries: 5, sleep: async () => {}, random: () => 0 },
    ).catch((e: unknown) => e);

    expect((err as BudgetaryError).attempts).toBe(1);
    expect((err as BudgetaryError).totalElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("invokes onRetry before each backoff with the attempt, delay, and status", async () => {
    const clk = fakeClock();
    const seen: RetryInfo[] = [];
    let attempt = 0;
    await withRetry(
      async () => {
        attempt += 1;
        if (attempt < 3) {
          throw new BudgetaryServerError({ code: "internal_error", message: "x", httpStatus: 503, requestId: null });
        }
        return "ok";
      },
      { maxRetries: 5, sleep: clk.sleep, now: clk.now, random: () => 1, onRetry: (i) => seen.push(i) },
    );

    // Two failures → two onRetry calls (before the 2 sleeps); the 3rd attempt succeeds.
    expect(seen).toEqual([
      { attempt: 1, delayMs: 1000, httpStatus: 503 },
      { attempt: 2, delayMs: 2000, httpStatus: 503 },
    ]);
  });

  it("reports the 429 status to onRetry (not only 5xx)", async () => {
    const seen: RetryInfo[] = [];
    let n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n < 2) {
          throw new BudgetaryRateLimitError({ code: "rate_limited", message: "x", httpStatus: 429, requestId: null, retryAfterSeconds: null });
        }
        return "ok";
      },
      { maxRetries: 3, sleep: async () => {}, random: () => 1, onRetry: (i) => seen.push(i) },
    );
    expect(seen.map((i) => i.httpStatus)).toEqual([429]);
  });

  it("swallows a throw from onRetry (a diagnostic hook never derails the request)", async () => {
    let attempt = 0;
    const res = await withRetry(
      async () => {
        attempt += 1;
        if (attempt < 2) {
          throw new BudgetaryServerError({ code: "internal_error", message: "x", httpStatus: 500, requestId: null });
        }
        return "ok";
      },
      {
        maxRetries: 3,
        sleep: async () => {},
        random: () => 0,
        onRetry: () => {
          throw new Error("observer blew up");
        },
      },
    );
    expect(res).toBe("ok"); // the request still completed
  });
});

describe("withRetry — de-sync jitter above the Retry-After floor (R-1)", () => {
  // Compute the single 429 backoff for a given injected random.
  async function backoffFor(rand: number): Promise<number> {
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n === 1) {
          throw new BudgetaryRateLimitError({
            code: "rate_limited",
            message: "slow down",
            httpStatus: 429,
            requestId: null,
            retryAfterSeconds: 1, // the SAME header a correlated fleet all sees
          });
        }
        return "ok";
      },
      { maxRetries: 2, sleep: async (ms) => { sleeps.push(ms); }, random: () => rand },
    );
    return sleeps[0]!;
  }

  it("spreads a correlated fleet's backoff instead of collapsing it into one bucket", async () => {
    // computed at attempt 0 = 1000, floor = retryAfter*1000 = 1000.
    const a = await backoffFor(0.2); // 1000 + 0.2*1000
    const b = await backoffFor(0.8); // 1000 + 0.8*1000
    // Never earlier than the server asked (the floor holds) …
    expect(a).toBeGreaterThanOrEqual(1000);
    expect(b).toBeGreaterThanOrEqual(1000);
    // … but jittered ON TOP, so two clients de-sync rather than fire together.
    expect(a).toBe(1200);
    expect(b).toBe(1800);
    expect(a).not.toBe(b);
  });
});

describe("withRetry — honors caller cancellation (R-2)", () => {
  it("does not even attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const err = await withRetry(
      async () => {
        attempts += 1;
        return "ok";
      },
      { maxRetries: 3, sleep: async () => {}, signal: controller.signal },
    ).catch((e: unknown) => e);
    expect(attempts).toBe(0);
    expect(err).toBeInstanceOf(BudgetaryNetworkError);
    expect((err as BudgetaryError).code).toBe("abort");
  });

  it("stops the ladder mid-backoff on abort (no further attempt, no full sleep)", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let started!: () => void;
    const sleepBegan = new Promise<void>((r) => (started = r));
    const p = withRetry(
      async () => {
        attempts += 1;
        throw new BudgetaryServerError({
          code: "internal_error",
          message: "boom",
          httpStatus: 500,
          requestId: null,
        });
      },
      {
        maxRetries: 5,
        random: () => 1,
        signal: controller.signal,
        // Never resolves on its own — only the abort ends the backoff.
        sleep: () =>
          new Promise<void>(() => {
            started();
          }),
      },
    );
    const settled = p.then(() => "resolved").catch((e: unknown) => e);
    await sleepBegan; // attempt 1 has failed and the backoff sleep is in progress
    controller.abort();
    const result = await settled;
    // The abort cut the sleep short and stopped the ladder — only one attempt ran.
    expect(attempts).toBe(1);
    expect(result).toBeInstanceOf(BudgetaryNetworkError);
    expect((result as BudgetaryError).code).toBe("abort");
  });
});

describe("BudgetaryClient — signal aborts an in-flight estimate (R-2 integration)", () => {
  it("rejects promptly with an abort when the caller aborts the request", async () => {
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/estimate`, async () => {
        await delay(5000); // still 'in flight' when we abort
        return HttpResponse.json({ estimate_id: "never", void: true });
      }),
    );
    const client = new BudgetaryClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      maxRetries: 5,
    });
    const controller = new AbortController();
    const pending = client
      .estimate("hi", { clientRequestId: null, signal: controller.signal })
      .catch((e: unknown) => e);
    // Abort mid-flight (before the 5 s handler or the 10 s timeout could fire).
    setTimeout(() => controller.abort(), 10);
    const err = await pending;
    expect(err).toBeInstanceOf(BudgetaryNetworkError);
    expect((err as BudgetaryError).code).toBe("abort");
  }, 15_000);

  it("classifies a host abort with a non-Error reason as code 'abort' (not 'network')", async () => {
    // The MCP host aborts with a STRING reason (CancelledNotification.reason is
    // an optional string, forwarded as controller.abort(reason)). undici then
    // rejects the fetch with that raw string — not an Error — so classifying by
    // the rejection's shape would mislabel a deliberate cancellation 'network'.
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/estimate`, async () => {
        await delay(5000);
        return HttpResponse.json({ estimate_id: "never", void: true });
      }),
    );
    const client = new BudgetaryClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      maxRetries: 5,
    });
    const controller = new AbortController();
    const pending = client
      .estimate("hi", { clientRequestId: null, signal: controller.signal })
      .catch((e: unknown) => e);
    setTimeout(() => controller.abort("host cancelled"), 10);
    const err = await pending;
    expect(err).toBeInstanceOf(BudgetaryNetworkError);
    // Signal-state classification wins over the raw string rejection.
    expect((err as BudgetaryError).code).toBe("abort");
  }, 15_000);
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

  it("reuses ONE auto-generated client_request_id across retries (never re-bills)", async () => {
    // The invariant the whole cost story rests on: the SDK resolves the
    // idempotency key ONCE, outside the retry loop, so 500 → 500 → 200 replays
    // the SAME client_request_id and the server dedups instead of double-billing.
    // Deliberately does NOT pass `clientRequestId` — it exercises the DEFAULT,
    // auto-generated id path (every other retry test opts out with `null`, so a
    // refactor moving key resolution into the attempt loop would pass CI while
    // silently re-billing). If this ever sees >1 distinct id, retries re-bill.
    const ids: Array<string | undefined> = [];
    let calls = 0;
    handle.use(
      http.post(`${TEST_BASE_URL}/v1/estimate`, async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as { client_request_id?: string };
        ids.push(body.client_request_id);
        if (calls < 3) {
          return HttpResponse.json(
            { error: { code: "internal_error", message: "x", request_id: "r" } },
            { status: 500 },
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

    const client = new BudgetaryClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      maxRetries: 5,
    });

    const res = await client.estimate("hi"); // default id — no opt-out
    expect(res.estimateId).toBe("est_ok");
    expect(calls).toBe(3);
    expect(ids).toHaveLength(3);
    // A real id was sent (not omitted) AND all three attempts carried the SAME one.
    expect(ids[0]).toBeTruthy();
    expect(new Set(ids).size).toBe(1);
  }, 15_000);
});
