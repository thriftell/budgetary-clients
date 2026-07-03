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
  /**
   * Discrete, content-free change accounting for the run — two MEASURED integers
   * that let the server report whether the spend converted into edits that stuck.
   * They are **counts of file-mutating tool events, never lines, never content**:
   * no path, diff, or change text is implied or attached.
   *
   *  - `producedChanges` — successful file-mutating tool calls in the run
   *    (`Edit`/`Write`/`MultiEdit` family), counted as **discrete events**.
   *  - `acceptedChanges` — of those, how many were still present at session
   *    close: a produced change is decremented when a later successful edit/write
   *    to the **same file** superseded it within the session. Conservative and
   *    `<= producedChanges` (a within-session survival proxy — under-counts,
   *    never over-counts).
   *
   * Both are measured from the run's own edit events, **never model-supplied**,
   * and both are **omitted together** on hosts that expose no per-edit events or
   * when the operator opts out of trace detail. The server derives any
   * cost-per-accepted efficiency view; the client classifies and scores nothing.
   */
  producedChanges?: number;
  acceptedChanges?: number;
  /**
   * Structural-existence accounting for the run's produced Python code — two
   * MEASURED integers that let the server report how often code **runs but
   * references a symbol that doesn't exist**. They are **counts, never content**:
   * no symbol name, import statement, file path, or line of code is implied or
   * attached.
   *
   *  - `externalSymbols` — distinct **external, top-level** module imports across
   *    the run's produced `.py` artifacts (relative/local imports and the
   *    project's own modules are excluded; a submodule like `os.path` counts once
   *    under its top-level name `os`).
   *  - `unresolvedSymbols` — of those, how many a static resolver found to be
   *    **confidently absent** in the interpreter that produced them, checked with
   *    `importlib.util.find_spec` on the top-level name (which resolves **without
   *    executing** the module body). Conservative and `<= externalSymbols`: every
   *    ambiguity (parse error, conditional/dynamic import, resolver error) is
   *    treated as resolved, so this **under-counts, never over-counts**.
   *
   * Both are measured by a linter-grade static resolver over observed artifacts,
   * **never model-supplied**, and both are **omitted together** when resolution
   * is not observable (no produced Python, no interpreter, resolver error) or the
   * operator opts out of trace detail. The measurement is **structural existence
   * only** — not semantic correctness, not a per-file "you hallucinated" flag; the
   * server turns it into a coverage-gated, regional rate. The client classifies,
   * scores, and benchmarks nothing.
   */
  externalSymbols?: number;
  unresolvedSymbols?: number;
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
