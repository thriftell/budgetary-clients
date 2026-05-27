/**
 * Known scenario labels in v1. The wire protocol may add new labels at any
 * time; callers should treat any value outside this union as `"uncertain"`.
 */
export type Scenario =
  | "confident"
  | "uncertain"
  | "sparse_evidence"
  | "out_of_domain";

export interface Distribution {
  p10: number;
  p50: number;
  p90: number;
  unit: "tokens";
}

export interface EstimateContext {
  host?: string;
  projectId?: string;
  depthBudget?: number;
}

export interface EstimateRequest {
  query: string;
  model?: string;
  context?: EstimateContext;
  clientRequestId?: string;
}

export interface EstimateResponse {
  estimateId: string;
  /**
   * One of the known {@link Scenario} values, or a future label. Callers
   * should treat unknown labels as `"uncertain"`.
   */
  scenario: Scenario | string;
  void: boolean;
  distribution: Distribution | null;
  confidence: number;
  model: string;
  expiresAt: string;
}

export interface ActualsMetadata {
  [key: string]: unknown;
}

export interface ActualsRequest {
  estimateId: string;
  tokensIn: number;
  tokensOut: number;
  success: boolean;
  durationMs: number;
  metadata?: ActualsMetadata;
}

export interface ActualsResponse {
  received: boolean;
  ledgerEntryId: string;
}

export interface LedgerQuery {
  projectId?: string;
  host?: string;
  after?: string;
  limit?: number;
  includeOrphans?: boolean;
  since?: string;
}

export interface LedgerActual {
  tokensIn: number;
  tokensOut: number;
  total: number;
  durationMs: number;
  success: boolean;
}

export interface LedgerPredicted {
  p10: number;
  p50: number;
  p90: number;
}

export interface LedgerEntry {
  estimateId: string;
  createdAt: string;
  queryExcerpt: string;
  model: string;
  host: string;
  projectId: string | null;
  scenario: Scenario | string;
  predicted: LedgerPredicted;
  actual: LedgerActual | null;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  nextCursor: string | null;
}
