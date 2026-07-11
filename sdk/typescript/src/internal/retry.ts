import {
  BudgetaryError,
  BudgetaryNetworkError,
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
  /**
   * Injectable MONOTONIC clock (ms) for elapsed tracking; defaults to
   * `performance.now()`. Monotonic (not wall-clock `Date.now`) so an NTP step or
   * a manual clock change mid-retry can't produce a negative or wrong
   * `totalElapsedMs`. Parity with Python's `time.monotonic`.
   */
  now?: () => number;
  /** Observe each retry (attempt just failed, backoff about to sleep). Never throws the run. */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Caller cancellation. When it aborts, the retry ladder stops immediately —
   * a backoff sleep in progress is cut short and no further attempt is made — so
   * a host-abandoned request sheds load instead of finishing its full ~5 min
   * ladder against a struggling engine. (The per-attempt request is aborted
   * separately, via the combined signal the HTTP layer passes to `fetch`.)
   */
  signal?: AbortSignal;
}

/** The typed error thrown when a retry backoff is cut short by an abort. */
function abortError(): BudgetaryNetworkError {
  return new BudgetaryNetworkError({
    code: "abort",
    message: "request was aborted",
  });
}

/**
 * Race an INJECTED `sleep` against the abort so an abandoned request doesn't sit
 * out the full backoff. (The default sleep is itself abort-aware; this exists for
 * a caller-supplied `sleep` that has no signal channel.) Detaches its listener so
 * a resolved sleep leaks nothing.
 */
async function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return sleep(ms);
  if (signal.aborted) throw abortError();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 60_000;

/**
 * Default backoff sleep. Abort-aware: an abort rejects promptly AND clears the
 * timer, so an abandoned request leaves no lingering `setTimeout` firing up to
 * `maxDelay` later.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Monotonic default clock (ms). `performance.now` is monotonic; `Date.now` is not. */
function defaultNow(): number {
  return performance.now();
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
  // An injected sleep (tests) has no signal channel, so it is raced against the
  // abort; the default sleep is itself abort-aware and clears its own timer.
  const injectedSleep = options.sleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? defaultNow;
  const onRetry = options.onRetry;
  const signal = options.signal;

  const startedAt = now();
  let attempt = 0;
  while (true) {
    // A caller that abandoned the request before this attempt starts: don't
    // fire another request at a struggling engine.
    if (signal?.aborted) throw abortError();
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
      // Retry-After budget guard: if the server's stated wait EXCEEDS the most
      // we would ever sleep in one backoff (`maxDelay`), then sleeping the
      // clamped `maxDelay` and retrying would fire BEFORE the server said success
      // is possible — a guaranteed second 429 that wastes an attempt and hammers
      // an already-strained engine the instant a too-short window "opens". Fail
      // fast instead, propagating the rate-limit error with `retryAfterSeconds`
      // intact so the caller can honor the FULL, honest wait. (An oversized or
      // hostile header therefore no longer costs a wasted retry — it sheds load.)
      if (
        err instanceof BudgetaryRateLimitError &&
        err.retryAfterSeconds !== null &&
        err.retryAfterSeconds !== undefined &&
        err.retryAfterSeconds * 1000 > maxDelay
      ) {
        annotateAttempts(err, attemptsMade, now() - startedAt);
        throw err;
      }
      const computed = Math.min(initialDelay * factor ** attempt, maxDelay);
      const jitter = random() * computed;
      let delay = jitter;
      if (
        err instanceof BudgetaryRateLimitError &&
        err.retryAfterSeconds !== null &&
        err.retryAfterSeconds !== undefined
      ) {
        // Respect the server's Retry-After as a FLOOR, then ADD jitter on top —
        // never a deterministic `max(retryAfter, computed)`. A correlated fleet
        // all seeing the same `Retry-After: 1` at a fixed-window boundary would
        // otherwise re-synchronize into one 1 s bucket and thundering-herd the
        // engine the instant the window opens; the additive jitter spreads them
        // across [retryAfter, retryAfter+computed). Here `retryAfter*1000 <=
        // maxDelay` (a longer wait already failed fast above), so the clamp only
        // trims the jitter tail — the floor is always honored.
        delay = Math.min(err.retryAfterSeconds * 1000 + jitter, maxDelay);
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
      // Signal-aware backoff: an abort mid-sleep rejects here and stops the
      // ladder, rather than sitting out the full delay and then retrying.
      if (injectedSleep !== undefined) {
        await abortableSleep(injectedSleep, delay, signal);
      } else {
        await defaultSleep(delay, signal);
      }
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
