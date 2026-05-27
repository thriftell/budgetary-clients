import {
  BudgetaryRateLimitError,
  BudgetaryServerError,
} from "../errors.js";

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  return (
    err instanceof BudgetaryServerError ||
    err instanceof BudgetaryRateLimitError
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries);
  const initialDelay = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const factor = options.factor ?? DEFAULT_FACTOR;
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) {
        throw err;
      }
      const computed = Math.min(initialDelay * factor ** attempt, maxDelay);
      let delay = random() * computed;
      if (
        err instanceof BudgetaryRateLimitError &&
        err.retryAfterSeconds !== null &&
        err.retryAfterSeconds !== undefined
      ) {
        delay = Math.max(err.retryAfterSeconds * 1000, computed);
      }
      await sleep(delay);
      attempt += 1;
    }
  }
}
