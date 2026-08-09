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

/**
 * The `POST /v1/estimate` request body. **Reference only** — callers don't build
 * this; use {@link BudgetaryClient.estimate}(query, opts), which assembles it and
 * snake-cases the fields at the wire boundary.
 */
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
 * The closed run-termination vocabulary for {@link ActualsRequest.censoring}
 * (contract §4.2) — **how the run ended**, as a category:
 *
 * - `natural` — the run ended on its own; no cap was reached.
 * - `harness_watchdog` — a wall-clock watchdog in the calling harness killed it.
 * - `operative_cap` — a cap inside the agent host fired (max turns, context
 *   exhaustion, a declared token budget).
 * - `kill_switch` — a human or an automation deliberately aborted it.
 *
 * The server matches these **exactly** — no case folding, no trimming, no
 * aliasing — and drops anything else to `null` (unknown) without failing the
 * call. A caller does the same: forward a value from this set verbatim, or omit
 * the field entirely. **Never default to `natural`** — an unobserved ending
 * recorded as a normal completion is an affirmative false claim, and an absent
 * field is the honest record that nothing observed how the run ended.
 */
export const CENSORING_CATEGORIES = [
  "natural",
  "harness_watchdog",
  "operative_cap",
  "kill_switch",
] as const;

/** A member of the closed {@link CENSORING_CATEGORIES} vocabulary. */
export type CensoringCategory = (typeof CENSORING_CATEGORIES)[number];

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
 *    shell step, an allowlisted program name in the clear plus a salted,
 *    non-reversible digest of the rest of the command (`"pytest a1b2c3d4e5f6"`,
 *    `"go test 0f1e…"`) — a non-allowlisted program (pasted secret, private
 *    script) degrades to a bare digest; for a file tool, a bare digest of the
 *    path. It never carries a raw command, absolute path, file contents, or any
 *    argument — only an allowlisted program name and an opaque equality key.
 *    Omitted when it cannot be extracted safely, or when the operator opts out
 *    of trace detail.
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
   * Redacted descriptor of what the step acted on. Allowlisted program name +
   * salted, non-reversible digest for shell steps (a non-allowlisted program
   * degrades to a bare digest); bare path digest for file tools. Never a raw
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
   * Optional run-termination category (contract §4.2): how the run **ended**,
   * from the closed four-member {@link CENSORING_CATEGORIES} vocabulary. It is
   * measured harness- or client-side — a host's or harness's own termination
   * fact, the same class of measurement as the token counts — and **never
   * model-supplied**: a model's account of its own truncation is not a
   * measurement. Omit rather than guess: an absent field stores `null`
   * (unknown), which is the honest record when nothing observed the ending;
   * `natural` is an affirmative claim, never a default. ⚠️ The server stores
   * only the **first** submission's value for an `estimate_id` — a replay's
   * `censoring` is silently discarded — so it must ride the first submit.
   */
  censoring?: CensoringCategory;
  metadata?: ActualsMetadata;
}

/**
 * One behavior phase of a completed run's measured spend: the exact tokens it
 * accounts for and the `[0, 1]` share of the measured total they represent.
 */
export interface PhaseSlice {
  tokens: number;
  share: number;
}

/**
 * The measured breakdown of a completed run's realized spend into plain-language
 * behavior phases (contract §4.3, additive).
 *
 * **Measurement, not prediction.** The per-phase `tokens` are exact over the
 * tokens the forwarded {@link ActualsRequest.trace} reported, and the five shares
 * sum to `1.0` (within floating-point tolerance) when {@link totalTokens} is
 * greater than 0. Nothing here is a forecast, and nothing here is derived by a
 * client: the server owns every phase label, and an SDK caller renders these
 * numbers as received or renders nothing.
 *
 * Wire keys arrive `snake_case` and are camelCased by the transport
 * (`total_tokens` → `totalTokens`, `scheme_version` → `schemeVersion`). **Values
 * are never transformed.**
 */
export interface Phases {
  exploration: PhaseSlice;
  generation: PhaseSlice;
  testing: PhaseSlice;
  retries: PhaseSlice;
  other: PhaseSlice;
  /** The measured tokens this breakdown covers — the sum of the five phases. */
  totalTokens: number;
  /**
   * Identifies the classifier that produced the breakdown. It **may change** — do
   * not assume bit-for-bit reproducibility across versions, and never branch on
   * it to infer a capability.
   */
  schemeVersion: string;
}

/**
 * Known {@link Assessment.verdict} values (contract §4.3) — where a run's
 * realized total landed against **its own** predicted interval:
 *
 * - `normal` — inside the predicted `[p10, p90]` interval.
 * - `efficient` — below `p10` (cheaper than predicted).
 * - `elevated` — somewhat above `p90`.
 * - `anomalous` — far above `p90`.
 * - `insufficient_data` — the estimate gave no firm basis to judge this task
 *   against.
 *
 * `insufficient_data` is a **first-class, honest answer**, not an error and not a
 * partial verdict: it is the question "was that normal for a task like this?"
 * answered truthfully. Render it plainly, never as a failure and never with an
 * apology — and note that the measured {@link Phases} beside it is exact and
 * needs no comparison data at all.
 *
 * The server may add labels at any time (contract §3). An unrecognized value is
 * rendered **as received**, or as silence — never folded into a known verdict and
 * never given a client-invented label. There is deliberately no
 * `normalizeVerdict()` counterpart to {@link normalizeScenario}: an unknown
 * scenario has a safe cautious floor (`"uncertain"`), an unknown verdict has
 * none, and the SDK classifies nothing.
 */
export type AssessmentVerdict =
  | "normal"
  | "efficient"
  | "elevated"
  | "anomalous"
  | "insufficient_data";

/**
 * Known {@link Efficiency.label} values (contract §4.3) — a display bucket over
 * the composition of the measured spend. `insufficient_trace` is reported when
 * the forwarded trace was too thin to characterize; it is an honest answer, not a
 * confident bucket, and never a value to hide.
 *
 * Server-owned and open-ended, exactly like {@link AssessmentVerdict}: an
 * unrecognized label is printed as received or dropped, never re-bucketed.
 */
export type EfficiencyLabel =
  | "lean"
  | "retry_heavy"
  | "exploration_heavy"
  | "insufficient_trace";

/**
 * A descriptive read of **where** the measured spend went, derived purely from
 * the {@link Phases} breakdown (contract §4.3, additive).
 *
 * **This is composition, not productivity.** `burnShare` says how much of the
 * bill was churn — *never* whether the work was worth it. A `retry_heavy` task
 * may have shipped the right fix, and a `lean` one may have produced nothing
 * useful. Do not present it as value, ROI, or a quality score.
 */
export interface Efficiency {
  /**
   * The `0.0`–`1.0` fraction of measured spend in non-productive phases
   * (`retries` plus unclassified `other`). Wire key `burn_share`.
   */
  burnShare: number;
  label: EfficiencyLabel | (string & {});
}

/**
 * The plain-language read of a completed run, as carried on the `POST /v1/actuals`
 * 202 (contract §4.2). Exactly four keys — `verdict`, `note`, `efficiency` and
 * `schemeVersion`.
 *
 * ⚠ **Subset by design.** The two comparison blocks (`conversion`,
 * `resolution` — see {@link LedgerAssessment}) are computed only on
 * `GET /v1/ledger`, so they are **absent** here rather than `null`. Their absence
 * on this shape means *"not computed on this endpoint"* — it is **never** a value,
 * and never to be read as `insufficient_data`. A {@link LedgerAssessment} is
 * assignable to this type; the reverse is not.
 */
export interface Assessment {
  verdict: AssessmentVerdict | (string & {});
  /**
   * An optional plain sentence-fragment attached to an abnormal verdict (e.g.
   * `"retry-heavy"`), or `null` when there is none. **Do not parse it** — read
   * {@link verdict}, which is the machine-readable field.
   */
  note: string | null;
  /**
   * Composition of the measured spend. `null` when no trace was forwarded with
   * the actuals — it can never be inferred without measured steps, so `null`
   * renders as silence, never as a computed guess.
   */
  efficiency: Efficiency | null;
  /**
   * Identifies the assessment version and **may change**. Never branch on it.
   */
  schemeVersion: string;
}

export interface ActualsResponse {
  received: boolean;
  ledgerEntryId: string;
  /**
   * The measured phase breakdown for the run just submitted, when the deployment
   * computes one (additive, contract §4.2).
   *
   * Two absent states, and they mean different things: **`undefined`** — the
   * field was not on the response at all (an older deployment); **`null`** — the
   * server answered and has no breakdown to give (no trace was forwarded). Render
   * both as silence or an em-dash. Never substitute a computed value for either.
   */
  phases?: Phases | null;
  /**
   * The plain-language read of the run just submitted, when the deployment
   * computes one (additive, contract §4.2). `undefined`/`null` exactly as for
   * {@link phases} — and see {@link Assessment} for why `conversion` and
   * `resolution` are absent on this endpoint rather than `null`.
   */
  assessment?: Assessment | null;
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

/** Known {@link LedgerConversion.verdict} values (contract §4.3). */
export type ConversionVerdict =
  | "lean"
  | "normal"
  | "wasteful"
  | "insufficient_data";

/**
 * A cost-per-accepted-unit read: did the spend convert into output that **stuck**,
 * measured against comparable tasks (contract §4.3, additive). Served on
 * `GET /v1/ledger` only — see {@link Assessment}.
 *
 * **Read {@link verdict}, never the components as a score**, and never collapse
 * them into a single number. This is efficiency, not productivity: it measures
 * conversion of spend into *surviving* output, not whether that output was worth
 * it. `insufficient_data` is the honest answer when there is no basis to compare
 * against — not an error, and not a partial result.
 */
export interface LedgerConversion {
  /** Measured count of discrete changes produced; `null` when none were sent. */
  producedChanges: number | null;
  /** Of {@link producedChanges}, how many survived; `null` when none were sent. */
  acceptedChanges: number | null;
  /** Realized tokens per surviving change; `null` when nothing was accepted. */
  costPerAccepted: number | null;
  /**
   * This task's rank in the comparable-task distribution (`0.0` cheapest per
   * accepted change … `1.0` most expensive); `null` when there is no basis to
   * rank against. The distribution itself is never returned.
   */
  percentileVsPeers: number | null;
  verdict: ConversionVerdict | (string & {});
}

/** Known {@link LedgerResolution.verdict} values (contract §4.3). */
export type ResolutionVerdict = "low" | "elevated" | "insufficient_data";

/**
 * A structural-hallucination read: for tasks like this one, how often does code
 * run but reference a symbol that **does not exist** (contract §4.3, additive).
 * Served on `GET /v1/ledger` only — see {@link Assessment}.
 *
 * **Structural, not semantic:** it catches symbols that do not exist, *not* a real
 * API used with the wrong behavior, and *not* any logic error — so `low` means a
 * low structural-hallucination rate, **never** "correct". It is **regional, not a
 * per-output flag**: never read it as "this diff hallucinated, review it".
 * **Read {@link verdict}, never the components as a score.**
 */
export interface LedgerResolution {
  /** Measured count of distinct external symbols referenced; `null` when none were sent. */
  externalSymbols: number | null;
  /** Of {@link externalSymbols}, how many did not resolve; `null` when none were sent. */
  unresolvedSymbols: number | null;
  /**
   * This task's own `unresolved / external`; `null` when there was no external
   * surface to reference. A noisy per-task number, **not** a verdict on the output.
   */
  unresolvedRate: number | null;
  /**
   * The pooled symbol-level rate across comparable tasks; `null` when there is no
   * basis to pool. It is a symbol-level rate, **not** the fraction of tasks that
   * hallucinated. The distribution behind it is never returned.
   */
  regionRate: number | null;
  verdict: ResolutionVerdict | (string & {});
}

/**
 * The fuller assessment shape served on `GET /v1/ledger`: the four keys of
 * {@link Assessment} plus the two comparison blocks the ledger route
 * computes. A value of this type is assignable to {@link Assessment}.
 */
export interface LedgerAssessment extends Assessment {
  /**
   * Cost-per-accepted read. `null` when the server has none to give; `undefined`
   * when the field was not on the response at all. Both render as silence.
   */
  conversion?: LedgerConversion | null;
  /**
   * Structural-hallucination read. `null` when the server has none to give;
   * `undefined` when the field was not on the response at all. Both render as
   * silence.
   */
  resolution?: LedgerResolution | null;
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
  /**
   * The measured phase breakdown for this entry (additive, contract §4.3).
   * `null` when no trace was forwarded with the actuals; `undefined` when the
   * field was not on the response at all. Render either as silence or an
   * em-dash — never a computed guess.
   */
  phases?: Phases | null;
  /**
   * The plain-language read of this entry (additive, contract §4.3). `null` on an
   * entry with no actual yet; `undefined` when the field was not on the response
   * at all. Render either as silence.
   */
  assessment?: LedgerAssessment | null;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  nextCursor: string | null;
}
