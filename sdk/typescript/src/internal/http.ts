import {
  BudgetaryAuthError,
  BudgetaryError,
  BudgetaryNetworkError,
  BudgetaryNotFoundError,
  BudgetaryRateLimitError,
  BudgetaryServerError,
  BudgetaryValidationError,
} from "../errors.js";
import { withRetry } from "./retry.js";

export interface HttpClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
}

export interface HttpRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
}

const NETWORK_ERROR_MESSAGE = "network error while contacting Budgetary API";
const TIMEOUT_ERROR_MESSAGE = "request to Budgetary API timed out";

function snakeKey(key: string): string {
  return key.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
}

function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Remove trailing slashes from a base URL with a single linear scan.
 *
 * The obvious `value.replace(/\/+$/, "")` is quadratic: the start of `\/+` is
 * unanchored, so on input like `"…" + "/".repeat(n) + "x"` the engine retries
 * the greedy slash run from each of the n slash positions (O(n^2)) — the
 * "polynomial regular expression" ReDoS class. This loop is O(n) and carries
 * no backtracking, regardless of how the base URL was supplied.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f /* "/" */) end--;
  return value.slice(0, end);
}

export function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toSnakeCase);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[snakeKey(k)] = toSnakeCase(v);
    }
    return out;
  }
  return value;
}

export function toCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCamelCase);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[camelKey(k)] = toCamelCase(v);
    }
    return out;
  }
  return value;
}

interface WireErrorBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
  };
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const n = Number(header);
  if (Number.isFinite(n)) return n;
  // HTTP date format fallback: header may be an HTTP-date.
  const t = Date.parse(header);
  if (!Number.isNaN(t)) {
    const seconds = Math.max(0, Math.round((t - Date.now()) / 1000));
    return seconds;
  }
  return null;
}

function buildError(
  status: number,
  body: WireErrorBody | null,
  headers: Headers,
): BudgetaryError {
  const code = body?.error?.code ?? defaultCodeForStatus(status);
  const message =
    body?.error?.message ?? `Budgetary API returned HTTP ${status}`;
  const requestId =
    body?.error?.request_id ?? headers.get("x-request-id") ?? null;
  const args = { code, message, httpStatus: status, requestId };

  if (status === 401 || status === 403) return new BudgetaryAuthError(args);
  if (status === 404) return new BudgetaryNotFoundError(args);
  if (status === 400 || status === 409 || status === 413) {
    return new BudgetaryValidationError(args);
  }
  if (status === 429) {
    return new BudgetaryRateLimitError({
      ...args,
      retryAfterSeconds: parseRetryAfter(headers.get("retry-after")),
    });
  }
  if (status >= 500) return new BudgetaryServerError(args);
  return new BudgetaryError(args);
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "authentication_failed";
    case 403:
      return "permission_denied";
    case 404:
      return "not_found";
    case 409:
      return "idempotency_conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    case 503:
      return "unavailable";
    default:
      return status >= 500 ? "internal_error" : `http_${status}`;
  }
}

function buildQueryString(
  query: HttpRequest["query"] | undefined,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(snakeKey(k), String(v));
  }
  const s = params.toString();
  return s.length > 0 ? `?${s}` : "";
}

export class HttpClient {
  private readonly config: HttpClientConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpClientConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async request<T>(req: HttpRequest): Promise<T> {
    const result = await withRetry(() => this.attempt(req), {
      maxRetries: this.config.maxRetries,
    });
    return result as T;
  }

  private async attempt(req: HttpRequest): Promise<unknown> {
    const url =
      stripTrailingSlashes(this.config.baseUrl) +
      req.path +
      buildQueryString(req.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };

    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(toSnakeCase(req.body));
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: req.method,
        headers,
        body,
        signal,
      });
    } catch (err) {
      throw mapNetworkError(err);
    }

    let parsed: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new BudgetaryNetworkError({
            code: "network",
            message: "received non-JSON response from Budgetary API",
          });
        }
        parsed = null;
      }
    }

    if (!response.ok) {
      throw buildError(
        response.status,
        parsed as WireErrorBody | null,
        response.headers,
      );
    }

    return toCamelCase(parsed);
  }
}

function mapNetworkError(err: unknown): BudgetaryError {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") {
      return new BudgetaryNetworkError({
        code: "timeout",
        message: TIMEOUT_ERROR_MESSAGE,
      });
    }
    if (err.name === "AbortError") {
      return new BudgetaryNetworkError({
        code: "abort",
        message: "request was aborted",
      });
    }
    return new BudgetaryNetworkError({
      code: "network",
      message: `${NETWORK_ERROR_MESSAGE}: ${err.message}`,
    });
  }
  return new BudgetaryNetworkError({
    code: "network",
    message: NETWORK_ERROR_MESSAGE,
  });
}
