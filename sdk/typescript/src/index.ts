export { BudgetaryClient } from "./client.js";
export type {
  BudgetaryClientOptions,
  EstimateCallOptions,
} from "./client.js";

export {
  BudgetaryError,
  BudgetaryAuthError,
  BudgetaryPermissionError,
  BudgetaryRateLimitError,
  BudgetaryNotFoundError,
  BudgetaryValidationError,
  BudgetaryServerError,
  BudgetaryNetworkError,
} from "./errors.js";
export type { BudgetaryNetworkErrorCode } from "./errors.js";

export { normalizeScenario } from "./types.js";
export type {
  Scenario,
  Distribution,
  EstimateContext,
  EstimateRequest,
  EstimateResponse,
  ActualsMetadata,
  ActualsTraceStep,
  ActualsRequest,
  ActualsResponse,
  LedgerQuery,
  LedgerPage,
  LedgerEntry,
  LedgerActual,
  LedgerPredicted,
} from "./types.js";
