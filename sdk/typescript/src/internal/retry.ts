import {
  BudgetaryError,
  BudgetaryRateLimitError,
  BudgetaryServerError,
} from "../errors.js";

/** Detail passed to {@link RetryOptions.onRetry} before each backoff sleep. */
export interface RetryInfo {
  /** Attempts made so far, including the one that just failed (1-based). */
  attempt: number;
  /** The backoff about to be slept before the next attempt, in ms. */
  delayMs: number;
  /** HTTP status of the failing response, or `null` for a transport failure. */
  httpStatus: number | null;
}

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Injectable monotonic clock (ms) for elapsed tracking; defaults to `Date.now`. */
  now?: () => number;
  /** Observe each retry (attempt just failed, backoff about to sleep). Never throws the run. */
  onRetry?: (info: RetryInfo) => void;
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
  const now = options.now ?? Date.now;
  const onRetry = options.onRetry;

  const startedAt = now();
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      // `attempt` is 0-based (retries taken); this attempt just failed, so the
      // number of attempts MADE is attempt + 1.
      const attemptsMade = attempt + 1;
      if (!isRetryable(err) || attempt >= maxRetries) {
        // Terminal (non-retryable) or exhausted: annotate the error with how many
        // attempts and how long the whole ordeal took, so ~4 min of 429 backoff
        // doesn't read as a first-attempt blip. Additive — never changes the type.
        annotateAttempts(err, attemptsMade, now() - startedAt);
        throw err;
      }
      const computed = Math.min(initialDelay * factor ** attempt, maxDelay);
      let delay = random() * computed;
      if (
        err instanceof BudgetaryRateLimitError &&
        err.retryAfterSeconds !== null &&
        err.retryAfterSeconds !== undefined
      ) {
        // Respect the server's Retry-After as a floor, but never sleep past
        // `maxDelay`: an oversized or hostile header must not hang the client
        // for minutes. `computed` is already <= maxDelay, so the outer min only
        // ever clamps the Retry-After value.
        delay = Math.min(
          Math.max(err.retryAfterSeconds * 1000, computed),
          maxDelay,
        );
      }
      if (onRetry !== undefined) {
        const httpStatus = err instanceof BudgetaryError ? err.httpStatus : null;
        // The observer is a diagnostic hook; a throw from it must not derail the
        // request (or convert a retryable failure into an uncaught error).
        try {
          onRetry({ attempt: attemptsMade, delayMs: delay, httpStatus });
        } catch {
          // ignore observer faults
        }
      }
      await sleep(delay);
      attempt += 1;
    }
  }
}

/** Stamp `attempts` + `totalElapsedMs` onto a Budgetary error (additive, best-effort). */
function annotateAttempts(err: unknown, attempts: number, elapsedMs: number): void {
  if (err instanceof BudgetaryError) {
    err.attempts = attempts;
    err.totalElapsedMs = elapsedMs;
  }
}
