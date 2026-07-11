import { BudgetaryNetworkError } from "./errors.js";
import { HttpClient, type HttpClientConfig } from "./internal/http.js";
import type { RetryInfo } from "./internal/retry.js";
import { assertAllowedBaseUrl } from "./internal/url.js";
import { resolveClientRequestId } from "./internal/idempotency.js";
import type {
  ActualsRequest,
  ActualsResponse,
  EstimateContext,
  EstimateResponse,
  LedgerPage,
  LedgerQuery,
} from "./types.js";

export interface BudgetaryClientOptions {
  apiKey: string;
  /** Default `https://api.budgetary.tools`. */
  baseUrl?: string;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /**
   * Maximum retries on `5xx` and `429`. Default 4, i.e. 5 total attempts —
   * the contract's "give up after 5 attempts" (§8).
   */
  maxRetries?: number;
  /** Override for the global `fetch`. Mainly for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Allow a non-HTTPS `baseUrl` to carry the API key. Default `false`: a
   * non-`https:` base URL is refused unless it is a localhost address, so the
   * bearer token is never sent in cleartext to a real host. Set `true` only for
   * a trusted local/lab endpoint you control.
   */
  allowInsecure?: boolean;
  /**
   * Optional observer invoked before each backoff sleep on a retryable failure
   * (5xx / 429), with the attempt count, the delay about to be slept, and the
   * HTTP status. Purely diagnostic — a throw from it is swallowed and never
   * derails the request. Use it to log/telemeter a slow retry ordeal.
   */
  onRetry?: (info: RetryInfo) => void;
}

export interface EstimateCallOptions {
  model?: string;
  context?: EstimateContext;
  /**
   * Client-supplied idempotency key.
   *  - `undefined` (default): SDK generates a fresh UUID v4.
   *  - `null`: explicit opt-out — no `client_request_id` is sent.
   *  - `string`: sent verbatim.
   */
  clientRequestId?: string | null;
  /** Per-call timeout override. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.budgetary.tools";
const DEFAULT_TIMEOUT_MS = 10_000;
// 4 retries + the initial attempt = 5 total, per contract §8.
const DEFAULT_MAX_RETRIES = 4;

/**
 * Shape-validate a 2xx estimate body before it becomes an `EstimateResponse`.
 * The transport layer only checks that numbers are finite; it does not check
 * SHAPE or TYPE, so an empty body (parsed to `null`), a wrong-shape 200 (missing
 * `distribution`), or a wrong-TYPE 200 (string percentiles — `"123"` renders as
 * a real number and gets stored as a fabricated estimate) would otherwise reach
 * the caller intact. Require the load-bearing fields — a non-empty string
 * `estimateId`, a boolean `void`, and a distribution with finite-number
 * `p10`/`p50`/`p90` when not void — and reject anything else as a network-class
 * failure (mirrors the Python SDK's `parse`). Runs OUTSIDE `withRetry`, so a
 * deterministically-bad body fails fast rather than being retried.
 */
function parseEstimateResponse(raw: unknown): EstimateResponse {
  const unusable = (why: string): never => {
    throw new BudgetaryNetworkError({
      code: "network",
      message: `unusable response body from Budgetary API (${why})`,
    });
  };
  if (raw === null || typeof raw !== "object") unusable("not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.estimateId !== "string" || o.estimateId.length === 0) {
    unusable("missing estimateId");
  }
  if (typeof o.void !== "boolean") unusable("missing void");
  if (o.void !== true) {
    const d = o.distribution;
    if (d === null || typeof d !== "object") unusable("missing distribution");
    const dist = d as Record<string, unknown>;
    for (const k of ["p10", "p50", "p90"] as const) {
      // typeof-number is the real gate: `assertFiniteNumbers` upstream never runs
      // on a string, so a string percentile would otherwise render as a number.
      if (typeof dist[k] !== "number" || !Number.isFinite(dist[k])) {
        unusable(`non-numeric ${k}`);
      }
    }
  }
  return raw as EstimateResponse;
}

export class BudgetaryClient {
  private readonly http: HttpClient;

  constructor(opts: BudgetaryClientOptions) {
    // Fail fast on a missing key rather than sending `Bearer ` and surfacing an
    // opaque 401 on the first call.
    if (typeof opts.apiKey !== "string" || opts.apiKey.trim().length === 0) {
      throw new Error(
        "BudgetaryClient: `apiKey` is required — pass a non-empty Budgetary API key.",
      );
    }
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    // Refuse to attach the bearer token to a non-HTTPS, non-localhost base URL
    // (unless explicitly opted in) — it would travel in cleartext.
    assertAllowedBaseUrl(baseUrl, opts.allowInsecure ?? false);
    const config: HttpClientConfig = {
      apiKey: opts.apiKey,
      baseUrl,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      fetchImpl: opts.fetchImpl,
      onRetry: opts.onRetry,
    };
    this.http = new HttpClient(config);
  }

  async estimate(
    query: string,
    opts: EstimateCallOptions = {},
  ): Promise<EstimateResponse> {
    const clientRequestId = resolveClientRequestId(opts.clientRequestId);
    const body: Record<string, unknown> = { query };
    if (opts.model !== undefined) body.model = opts.model;
    if (opts.context !== undefined) body.context = opts.context;
    if (clientRequestId !== undefined) body.clientRequestId = clientRequestId;

    const raw = await this.http.request<unknown>({
      method: "POST",
      path: "/v1/estimate",
      body,
      timeoutMs: opts.timeoutMs,
    });
    return parseEstimateResponse(raw);
  }

  async submitActuals(actuals: ActualsRequest): Promise<ActualsResponse> {
    return this.http.request<ActualsResponse>({
      method: "POST",
      path: "/v1/actuals",
      body: actuals,
    });
  }

  async getLedger(query: LedgerQuery = {}): Promise<LedgerPage> {
    return this.http.request<LedgerPage>({
      method: "GET",
      path: "/v1/ledger",
      query: {
        projectId: query.projectId,
        host: query.host,
        after: query.after,
        limit: query.limit,
        includeOrphans: query.includeOrphans,
        since: query.since,
      },
    });
  }
}
