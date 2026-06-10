import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import {
  BudgetaryClient,
  BudgetaryError,
  BudgetaryRateLimitError,
  type BudgetaryClientOptions,
  type EstimateResponse,
} from "@budgetary/sdk";

import { noKeyGuidance, pendingFilePath, resolveConfig } from "../config.js";
import {
  renderAuthFailed,
  renderEstimate,
  renderPermissionDenied,
  renderRateLimited,
  renderTransportError,
} from "../format.js";
import { PendingStore, type PendingEntry } from "../store.js";

/** The default host tag when `BUDGETARY_HOST` is unset. */
export const DEFAULT_HOST = "mcp";

export interface EstimateToolArgs {
  query: string;
  model?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  home?: string;
  /** Override the SDK client (tests). */
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
  /** Override the now timestamp (tests). */
  now?: () => Date;
}

export interface EstimateToolResult {
  text: string;
  isError: boolean;
}

/** A non-reversible hash of the absolute working directory. */
export function projectIdFromCwd(cwd: string): string {
  const abs = resolvePath(cwd);
  return createHash("sha256").update(abs).digest("hex").slice(0, 16);
}

/**
 * The only model-invokable behavior. Resolves config, calls the estimate
 * endpoint, renders the result, and appends a pending entry on a non-void
 * estimate. Never throws — every gated/error state is returned as text so the
 * MCP host can show it inline.
 */
export async function runEstimateTool(
  args: EstimateToolArgs,
): Promise<EstimateToolResult> {
  const query = args.query?.trim() ?? "";
  if (query.length === 0) {
    return { text: "Budgetary: a task description is required.", isError: true };
  }

  const resolved = resolveConfig(args.env, args.home);
  if (resolved === null) {
    // Guidance, not an error: the host should surface it and let the user act.
    return { text: noKeyGuidance(), isError: false };
  }

  const host = args.env.BUDGETARY_HOST ?? DEFAULT_HOST;
  const projectId = projectIdFromCwd(args.cwd);

  const factory =
    args.clientFactory ??
    ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  const client = factory({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });

  let response: EstimateResponse;
  try {
    response = await client.estimate(query, {
      model: args.model,
      context: { host, projectId },
    });
  } catch (err) {
    return { text: renderEstimateError(err), isError: true };
  }

  if (!response.void) {
    const store = new PendingStore({ path: pendingFilePath(args.home) });
    const entry: PendingEntry = {
      estimate_id: response.estimateId,
      query,
      project_id: projectId,
      created_at: (args.now ?? (() => new Date()))().toISOString(),
      attempts: 0,
    };
    store.append(entry);
  }

  return { text: renderEstimate(response), isError: false };
}

function renderEstimateError(err: unknown): string {
  if (err instanceof BudgetaryRateLimitError) {
    return renderRateLimited(err.retryAfterSeconds);
  }
  if (err instanceof BudgetaryError) {
    // The SDK maps both 401 and 403 to BudgetaryAuthError, so distinguish by
    // HTTP status / wire code rather than by class.
    if (err.httpStatus === 403 || err.code === "permission_denied") {
      return renderPermissionDenied();
    }
    if (err.httpStatus === 401 || err.code === "authentication_failed") {
      return renderAuthFailed();
    }
    if (err.httpStatus === 429 || err.code === "rate_limited") {
      return renderRateLimited(null);
    }
    return renderTransportError(err.message, err.requestId);
  }
  return renderTransportError(
    err instanceof Error ? err.message : String(err),
    null,
  );
}
