import { HttpClient, type HttpClientConfig } from "./internal/http.js";
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
