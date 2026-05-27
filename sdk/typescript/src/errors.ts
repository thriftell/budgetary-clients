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

export class BudgetaryAuthError extends BudgetaryError {}

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
  constructor(args: { code: BudgetaryNetworkErrorCode; message: string }) {
    super({
      code: args.code,
      message: args.message,
      httpStatus: null,
      requestId: null,
    });
  }
}
