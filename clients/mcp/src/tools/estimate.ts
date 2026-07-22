import { createHmac } from "node:crypto";
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
  installSalt,
  keyPrefixOf,
  noKeyGuidance,
  pendingFilePath,
  resolveConfigStatus,
  resolveLanguage,
  resolveSource,
} from "../config.js";
import {
  renderAuthFailed,
  renderEstimate,
  renderPermissionDenied,
  renderRateLimited,
  renderRequestRejected,
  renderTransportError,
} from "../format.js";
import {
  isEntryExpired,
  MAX_QUERY_LEN,
  PendingStore,
  type PendingEntry,
} from "../store.js";

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
  /**
   * Host cancellation, forwarded to the SDK's `estimate` call so an abandoned
   * request stops retrying. Threaded from the MCP request `extra.signal`.
   */
  signal?: AbortSignal;
}

export interface EstimateToolResult {
  text: string;
  isError: boolean;
}

/**
 * A non-reversible, per-install identifier for the absolute working directory:
 * `HMAC-SHA256(install_salt, abs_cwd)` truncated to 16 hex. Because the salt is
 * a machine-local secret ({@link installSalt}) that never leaves the machine,
 * the server cannot dictionary-reverse the id back to a path or a
 * `~/<user>/<repo>` — while it stays STABLE across runs for one install (the
 * salt persists), so estimates keep grouping into the same project and actuals
 * still bind to their own session's estimate.
 */
export function projectIdFromCwd(cwd: string, home?: string): string {
  const abs = resolvePath(cwd);
  return createHmac("sha256", installSalt(home))
    .update(abs)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The only model-invokable behavior. Resolves config, calls the estimate
 * endpoint, renders the result, and appends a pending entry whenever the
 * response carries an estimate_id — VOID OR NOT (0024c). An out-of-domain query
 * voids (no forecast), but the outcome is still recordable, and those are exactly
 * the blank-region actuals the corpus needs to broaden coverage. Never throws —
 * every gated/error state is returned as text so the MCP host can show it inline.
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

  const projectId = projectIdFromCwd(args.cwd, args.home);

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
      signal: args.signal,
    });
  } catch (err) {
    return { text: renderEstimateError(err, host, resolved.source), isError: true };
  }

  // Belt-and-suspenders: the SDK now shape-validates the estimate body (a
  // wrong-shape/typed 2xx throws BudgetaryNetworkError, caught above), but this
  // render+store block still destructures `response` and must NEVER throw out of
  // the tool — the tool's contract is to return text, never throw. A malformed
  // shape that somehow reached here (an older SDK, an unexpected store/render
  // fault) is surfaced as graceful transport-error text, not a raw TypeError.
  try {
    // Only claim "stored" when the append actually succeeded; the footer degrades
    // to an honest "couldn't be stored" line otherwise. The store gets a logger so
    // the underlying cause is visible on stderr, not swallowed.
    let stored = true;
    // Count of THIS project's OTHER still-open estimates, computed from the
    // snapshot the append already returned — no second read/parse of the file.
    let others = 0;
    // Whether an UNEXPIRED pending entry already holds the identical query+project
    // — i.e. this estimate likely just re-billed a task already forecast. Surfaced
    // so the user can reuse the earlier one next time instead of paying twice.
    let dup = false;
    // 0024c: write a pending entry whenever the server returned an estimate_id —
    // void or not. The server persists the Estimate row and returns its id even on
    // a void (out-of-domain), so the id is pairable; gating this on `!void` (the old
    // behavior) silently DROPPED the out-of-domain outcomes — precisely the
    // blank-region actuals the corpus can't broaden coverage without. Prediction
    // confidence and outcome capture are orthogonal: we want the real actual most
    // exactly when we could not forecast it. `estimateId` is SDK-validated to be a
    // non-empty string on every response, so this is always true in practice; the
    // guard documents the invariant and skips a useless entry if it ever isn't.
    if (response.estimateId) {
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
        // Persist the forecast band (LOCAL only — the response already carried it)
        // so `pending`/`doctor`/the submit lines can later close the loop against
        // the realized actual. `distribution` is null on a VOID estimate, so the
        // spread then omits the band entirely — exactly right: a void has no
        // forecast, only a pairable estimate_id and the real actual still to come.
        ...(response.distribution
          ? {
              forecast_p10: response.distribution.p10,
              forecast_p50: response.distribution.p50,
              forecast_p90: response.distribution.p90,
            }
          : {}),
        // The declared provenance tag for THIS run, resolved from the environment
        // — the ONE place in the client that ever reads it. Stamping it on the
        // entry (rather than resolving it in the submit path) is what makes a
        // cross-session retry send the tag of the run that actually happened: the
        // submit is a later, separate process whose environment is unrelated.
        // Fail-open: an absent/invalid value is already the default here, so no
        // malformed tag can reach the store.
        source: resolveSource(args.env),
      };
      // Pass the tool's clock so the append-time TTL sweep is consistent with
      // the created_at just stamped above.
      const result = store.append(entry, { now: args.now });
      stored = result.stored;
      if (stored) {
        others = result.entries.filter(
          (e) => e.project_id === projectId && e.estimate_id !== response.estimateId,
        ).length;
        // Compare against the STORED (truncated) query form the snapshot holds.
        const storedQuery =
          query.length > MAX_QUERY_LEN ? query.slice(0, MAX_QUERY_LEN) : query;
        const nowMs = (args.now ?? (() => new Date()))().getTime();
        dup = result.entries.some(
          (e) =>
            e.estimate_id !== response.estimateId &&
            e.project_id === projectId &&
            e.query === storedQuery &&
            !isEntryExpired(e, nowMs),
        );
      }
    }

    let text = renderEstimate(response, {
      host,
      stored,
      keyPrefix: keyPrefixOf(resolved.apiKey),
    });
    // Nudge, best-effort (never fatal). Lead with the more specific duplicate
    // warning when this exact task is already forecast and unexpired — that's a
    // likely double-bill; otherwise the generic "earlier estimates await actuals".
    // NOT on a void (0024c): a void silently gains a pending entry, but its
    // user-facing text stays byte-for-byte what it was — confidence shapes the
    // message, recordability is orthogonal (spec §3).
    if (!response.void && stored && dup) {
      text +=
        "\n\n(You already have an UNEXPIRED estimate for this exact task in this " +
        "project — re-estimating bills again. Reuse it, or close it with " +
        "`npx @budgetary/mcp report-actual`.)";
    } else if (!response.void && stored && others > 0) {
      text +=
        `\n\n(${others} earlier ${others === 1 ? "estimate" : "estimates"} for ` +
        "this project still await actuals — run `npx @budgetary/mcp pending`.)";
    }
    return { text, isError: false };
  } catch (err) {
    return {
      text: renderTransportError(
        err instanceof Error ? err.message : String(err),
        null,
      ),
      isError: true,
    };
  }
}

function renderEstimateError(
  err: unknown,
  host: string,
  source: "env" | "config",
): string {
  if (err instanceof BudgetaryRateLimitError) {
    return renderRateLimited(err.retryAfterSeconds, {
      requestId: err.requestId,
      limit: err.limit,
      remaining: err.remaining,
      resetSeconds: err.resetSeconds,
      attempts: err.attempts,
      totalElapsedMs: err.totalElapsedMs,
    });
  }
  if (err instanceof BudgetaryError) {
    // The SDK maps 401 → BudgetaryAuthError and 403 → BudgetaryPermissionError
    // (both extend BudgetaryError). Distinguish by HTTP status / wire code so
    // this stays correct regardless of the class hierarchy. Thread the
    // server's request_id through every branch so a user reporting a rejected
    // key / plan / rate-limit can be traced (parity with the transport errors).
    if (err.httpStatus === 403 || err.code === "permission_denied") {
      return renderPermissionDenied(err.requestId);
    }
    if (err.httpStatus === 401 || err.code === "authentication_failed") {
      return renderAuthFailed(host, source, err.requestId);
    }
    if (err.httpStatus === 429 || err.code === "rate_limited") {
      return renderRateLimited(null, {
        requestId: err.requestId,
        attempts: err.attempts,
        totalElapsedMs: err.totalElapsedMs,
      });
    }
    // A 4xx the server deliberately rejected — state the reason + fix, never
    // "couldn't be reached, try again" (which is reserved for network / 5xx).
    const s = err.httpStatus;
    if (s !== null && s >= 400 && s < 500) {
      return renderRequestRejected(err.message, err.requestId, s);
    }
    // Network / 5xx: surface how many attempts + how long the SDK's retry ladder
    // burned (additive fields set on exhaustion), so a ~4 min ordeal is legible.
    return renderTransportError(
      err.message,
      err.requestId,
      err.attempts,
      err.totalElapsedMs,
    );
  }
  return renderTransportError(
    err instanceof Error ? err.message : String(err),
    null,
  );
}
