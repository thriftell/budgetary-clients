import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import {
  BudgetaryClient,
  BudgetaryError,
  BudgetaryRateLimitError,
  type BudgetaryClientOptions,
  type EstimateContext,
  type EstimateResponse,
} from "@budgetary/sdk";

import {
  noKeyGuidance,
  pendingFilePath,
  resolveConfigStatus,
  resolveLanguage,
} from "../config.js";
import {
  renderAuthFailed,
  renderEstimate,
  renderPermissionDenied,
  renderRateLimited,
  renderRequestRejected,
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

  const host = args.env.BUDGETARY_HOST ?? DEFAULT_HOST;

  const status = resolveConfigStatus(args.env, args.home);
  if (status.kind !== "ok") {
    // Guidance, not an error: the host should surface it and let the user act.
    // Host-aware, and honest about a broken config vs. no key at all.
    return {
      text: noKeyGuidance(host, status.kind === "unreadable" ? "unreadable" : "no-key"),
      isError: false,
    };
  }
  const resolved = status.config;

  const projectId = projectIdFromCwd(args.cwd);

  // Optional, deterministically-declared language tag — resolved from the
  // environment exactly like `host`, never from the model and never inferred
  // from the query. Omitted entirely when there is no signal (the server then
  // records honest `(none)`).
  const context: EstimateContext = { host, projectId };
  const language = resolveLanguage(args.env, args.home);
  if (language !== undefined) context.language = language;

  const factory =
    args.clientFactory ??
    ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  const client = factory({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });

  let response: EstimateResponse;
  try {
    response = await client.estimate(query, {
      model: args.model,
      context,
    });
  } catch (err) {
    return { text: renderEstimateError(err, host, resolved.source), isError: true };
  }

  // Only claim "stored" when the append actually succeeded; the footer degrades
  // to an honest "couldn't be stored" line otherwise. The store gets a logger so
  // the underlying cause is visible on stderr, not swallowed.
  let stored = true;
  if (!response.void) {
    const store = new PendingStore({
      path: pendingFilePath(args.home),
      logger: { warn: (m) => process.stderr.write(`${m}\n`) },
    });
    const entry: PendingEntry = {
      estimate_id: response.estimateId,
      query,
      project_id: projectId,
      created_at: (args.now ?? (() => new Date()))().toISOString(),
      attempts: 0,
    };
    stored = store.append(entry);
  }

  let text = renderEstimate(response, { host, stored });
  // Nudge: if earlier estimates for THIS project were never closed out, surface
  // it once (a lost actual shouldn't stay invisible). Best-effort — never fatal.
  if (stored) {
    const others = new PendingStore({ path: pendingFilePath(args.home) })
      .read()
      .entries.filter(
        (e) => e.project_id === projectId && e.estimate_id !== response.estimateId,
      ).length;
    if (others > 0) {
      text +=
        `\n\n(${others} earlier ${others === 1 ? "estimate" : "estimates"} for ` +
        "this project still await actuals — run `npx @budgetary/mcp pending`.)";
    }
  }
  return { text, isError: false };
}

function renderEstimateError(
  err: unknown,
  host: string,
  source: "env" | "config",
): string {
  if (err instanceof BudgetaryRateLimitError) {
    return renderRateLimited(err.retryAfterSeconds);
  }
  if (err instanceof BudgetaryError) {
    // The SDK maps 401 → BudgetaryAuthError and 403 → BudgetaryPermissionError
    // (both extend BudgetaryError). Distinguish by HTTP status / wire code so
    // this stays correct regardless of the class hierarchy.
    if (err.httpStatus === 403 || err.code === "permission_denied") {
      return renderPermissionDenied();
    }
    if (err.httpStatus === 401 || err.code === "authentication_failed") {
      return renderAuthFailed(host, source);
    }
    if (err.httpStatus === 429 || err.code === "rate_limited") {
      return renderRateLimited(null);
    }
    // A 4xx the server deliberately rejected — state the reason + fix, never
    // "couldn't be reached, try again" (which is reserved for network / 5xx).
    const s = err.httpStatus;
    if (s !== null && s >= 400 && s < 500) {
      return renderRequestRejected(err.message, err.requestId, s);
    }
    return renderTransportError(err.message, err.requestId);
  }
  return renderTransportError(
    err instanceof Error ? err.message : String(err),
    null,
  );
}
