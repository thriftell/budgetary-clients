export { BudgetaryClient } from "./client.js";
export type {
  BudgetaryClientOptions,
  EstimateCallOptions,
} from "./client.js";
export type { RetryInfo } from "./internal/retry.js";

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

export { normalizeScenario, CENSORING_CATEGORIES } from "./types.js";
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
  CensoringCategory,
  PhaseSlice,
  Phases,
  AssessmentVerdict,
  EfficiencyLabel,
  Efficiency,
  Assessment,
  ConversionVerdict,
  LedgerConversion,
  ResolutionVerdict,
  LedgerResolution,
  LedgerAssessment,
  LedgerQuery,
  LedgerPage,
  LedgerEntry,
  LedgerActual,
  LedgerPredicted,
} from "./types.js";

export {
  DEFAULT_BASE_URL,
  budgetaryDir,
  configFilePath,
  resolveConfig,
  resolveConfigStatus,
} from "./config.js";
export type { ConfigStatus, ResolvedConfig } from "./config.js";
