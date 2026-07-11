export interface BudgetaryErrorArgs {
  code: string;
  message: string;
  httpStatus: number | null;
  requestId: string | null;
}

export class BudgetaryError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  /**
   * How many attempts were made before this error was thrown. Set by the retry
   * wrapper: `1` when the first attempt failed non-retryably, up to `maxRetries + 1`
   * on exhaustion. `undefined` if the error never passed through the retry wrapper.
   * Additive and diagnostic — a ~4-minute 429/5xx backoff no longer looks like a
   * first-attempt blip.
   */
  attempts?: number;
  /**
   * Total wall-clock across every attempt AND the backoff sleeps between them, in
   * ms. Set alongside {@link attempts} on the final throw. `undefined` if the
   * error never passed through the retry wrapper.
   */
  totalElapsedMs?: number;

  constructor(args: BudgetaryErrorArgs) {
    super(args.message);
    this.name = this.constructor.name;
    this.code = args.code;
    this.httpStatus = args.httpStatus;
    this.requestId = args.requestId;
  }
}

/** 401: the API key is missing, malformed, or revoked. */
export class BudgetaryAuthError extends BudgetaryError {}

/**
 * 403: the key is valid but lacks the scope for this operation. Distinct from
 * {@link BudgetaryAuthError} so callers can tell "bad key" (re-authenticate)
 * apart from "authorized but gated" (a permission/plan problem) — see contract
 * §6 (`authentication_failed` vs `permission_denied`).
 */
export class BudgetaryPermissionError extends BudgetaryError {}

export class BudgetaryNotFoundError extends BudgetaryError {}

export class BudgetaryValidationError extends BudgetaryError {}

export class BudgetaryServerError extends BudgetaryError {}

export class BudgetaryRateLimitError extends BudgetaryError {
  readonly retryAfterSeconds: number | null;

  constructor(args: BudgetaryErrorArgs & { retryAfterSeconds: number | null }) {
    super(args);
    this.retryAfterSeconds = args.retryAfterSeconds;
  }
}

export type BudgetaryNetworkErrorCode = "timeout" | "network" | "abort";

export class BudgetaryNetworkError extends BudgetaryError {
  /** Narrowed from the base `string` so `err.code` autocompletes the 3 values. */
  declare readonly code: BudgetaryNetworkErrorCode;

  constructor(args: { code: BudgetaryNetworkErrorCode; message: string }) {
    super({
      code: args.code,
      message: args.message,
      httpStatus: null,
      requestId: null,
    });
  }
}
