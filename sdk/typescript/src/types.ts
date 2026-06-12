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

/**
 * One measured step of a run's execution trace. The `tokens` count is realized
 * usage on the same cache-read-excluded basis as {@link ActualsRequest.tokensIn}
 * / {@link ActualsRequest.tokensOut} — never model-supplied. `kind` is set to
 * `"turn-split"` when a single measured turn covered several tool calls and its
 * tokens were split evenly across them (per-tool usage is not in the data).
 *
 * `target` and `ok` are additive raw measurements that let the server decompose
 * more of a run — still behavior, never classification:
 *  - `target` is a **redacted** descriptor of what the step acted on: for a
 *    shell step, the program name in the clear plus a non-reversible digest of
 *    the rest of the command (`"pytest a1b2c3d4e5f6"`, `"go test 0f1e…"`); for a
 *    file tool, a bare digest of the path. It never carries a raw command,
 *    absolute path, file contents, or any argument — only the program name and
 *    an opaque equality key. Omitted when it cannot be extracted safely, or when
 *    the operator opts out of trace detail.
 *  - `ok` is the measured outcome: `false` exactly when the host flagged the
 *    tool result an error (`is_error`), `true` when it flagged success. Omitted
 *    when the host did not flag an outcome (never assumed).
 *
 * The trace carries host tool names, token counts, redacted targets, and
 * outcomes only. Phase labeling, retry detection, and any verdict are computed
 * server-side; the client classifies nothing.
 */
export interface ActualsTraceStep {
  tool: string;
  tokens: number;
  kind?: "turn-split";
  /**
   * Redacted descriptor of what the step acted on. Program name + non-reversible
   * digest for shell steps; bare path digest for file tools. Never a raw
   * path/argument/command. Optional and additive.
   */
  target?: string;
  /**
   * Measured outcome: `false` iff the host flagged the tool result an error,
   * `true` iff it flagged success. Omitted when no outcome was flagged. Never
   * model-supplied. Optional and additive.
   */
  ok?: boolean;
}

export interface ActualsRequest {
  estimateId: string;
  tokensIn: number;
  tokensOut: number;
  success: boolean;
  durationMs: number;
  /**
   * Optional additive execution trace. The server classifies it into phases
   * and drops it (without failing the call) if it is over-cap or malformed.
   */
  trace?: ActualsTraceStep[];
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
