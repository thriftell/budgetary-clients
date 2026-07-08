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
