import { HttpClient, type HttpClientConfig } from "./internal/http.js";
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

export class BudgetaryClient {
  private readonly http: HttpClient;

  constructor(opts: BudgetaryClientOptions) {
    const config: HttpClientConfig = {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      fetchImpl: opts.fetchImpl,
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

    return this.http.request<EstimateResponse>({
      method: "POST",
      path: "/v1/estimate",
      body,
      timeoutMs: opts.timeoutMs,
    });
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
