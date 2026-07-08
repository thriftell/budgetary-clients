/**
 * Known scenario labels in v1. The wire protocol may add new labels at any
 * time; callers should treat any value outside this union as `"uncertain"`.
 */
export type Scenario =
  | "confident"
  | "uncertain"
  | "sparse_evidence"
  | "out_of_domain";

/**
 * Fold any scenario string to a known {@link Scenario}. The wire may add labels
 * at any time (contract §5), so an unrecognized value becomes `"uncertain"` —
 * a caller must never treat an unknown label as if it were `"confident"`.
 */
export function normalizeScenario(scenario: string): Scenario {
  switch (scenario) {
    case "confident":
    case "uncertain":
    case "sparse_evidence":
    case "out_of_domain":
      return scenario;
    default:
      return "uncertain";
  }
}

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
  /**
   * Optional benign tag for the language the caller is working in (a host
   * display name such as `"TypeScript"` or `"Python"`). Same risk class as
   * {@link EstimateContext.host}: a behavior tag, never a classification.
   * Forwarded verbatim — the server owns normalization. Omit it entirely when
   * the caller has no reliable signal.
   */
  language?: string;
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
   * Scenario label (contract §5). One of the known {@link Scenario} values, or a
   * future label the server may add. Pass it through {@link normalizeScenario} to
   * fold any unknown value to `"uncertain"`. The `(string & {})` keeps editor
   * autocomplete for the known members while still accepting any wire string.
   */
  scenario: Scenario | (string & {});
  /**
   * `true` when the server declined to estimate (scenario `out_of_domain`): the
   * query is too far from anything it has calibration for. This is NOT an error —
   * render it as "we can't confidently estimate this". When `true`,
   * {@link distribution} is `null`, so branch on `void` before reading it.
   */
  void: boolean;
  /**
   * The predicted spend as a RANGE, not a single point: `p10`/`p50`/`p90`
   * combined input+output tokens. `null` on a {@link void} response. Present the
   * band — `p50` is the midpoint of a range, never a guaranteed cost.
   */
  distribution: Distribution | null;
  /**
   * Single user-facing quality summary in `[0, 1]`. Higher means a tighter,
   * better-supported estimate; a low value means the range is wide and the
   * midpoint is a rough guess. Read it alongside {@link scenario}, not as a
   * probability of any particular outcome.
   */
  confidence: number;
  /** The resolved model the estimate is for (an echo of the request, or the org default). */
  model: string;
  /**
   * RFC 3339 timestamp after which the estimate should be treated as stale (the
   * model may have moved since). Re-estimate rather than trusting an expired one.
   */
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
  /** Scenario label (contract §5); fold unknowns with {@link normalizeScenario}. */
  scenario: Scenario | (string & {});
  predicted: LedgerPredicted;
  actual: LedgerActual | null;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  nextCursor: string | null;
}
