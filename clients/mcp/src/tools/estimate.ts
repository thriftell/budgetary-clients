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
  measuredFilePath,
  noKeyGuidance,
  pendingFilePath,
  resolveConfigStatus,
  resolveLanguage,
  resolveSource,
} from "../config.js";
import {
  claimOneTimeNotice,
  contributionStatus,
  DATA_NOTICE,
  dataDisclosureLines,
  HOOKLESS_NOTICE,
  hooklessNoticeLines,
} from "../contribution.js";
import {
  measuredLines,
  renderAuthFailed,
  renderEstimate,
  renderPermissionDenied,
  renderRateLimited,
  renderRequestRejected,
  renderTransportError,
} from "../format.js";
import { MeasuredStore } from "../measured.js";
import {
  resolveSessionBinding,
  selectReconcilable,
  SESSION_ID_ENV,
} from "../session.js";
import {
  isEntryExpired,
  MAX_QUERY_LEN,
  PendingStore,
  type PendingEntry,
} from "../store.js";

/** The default host tag when `BUDGETARY_HOST` is unset. */
export const DEFAULT_HOST = "mcp";

/**
 * The client identity from the MCP `initialize` handshake, as the SDK's
 * `Server.getClientVersion()` surfaces it. Host-supplied on a protocol channel
 * established before the model ever spoke — the model cannot see, set, or
 * influence it. `name` is typed `unknown` on purpose: the SDK validates it as
 * `z.string()` and nothing else (empty, huge, control bytes and ANSI escapes
 * all parse), so every reader must prove the type and then compare it against
 * {@link attestedHost}'s frozen allowlist and discard it. The raw value is
 * never rendered, logged, stored, or interpolated.
 */
export interface HandshakeClientInfo {
  name?: unknown;
}

/**
 * Verified `clientInfo.name` → the host tag it attests. EXACT, case-sensitive
 * equality only — no trimming, no case folding, no prefix/substring/regex, no
 * normalisation of any kind. The measured hosts follow no shared naming
 * convention (Codex attests `codex-mcp-client`, not `codex`; VS Code would
 * attest a space-separated display name), so any coercion would be a guess
 * dressed as a rule — and Claude Code itself carries other identities on other
 * channels (`claude-cli-design-tool` on a first-party MCP endpoint, and an LSP
 * identity spelled `"Claude Code"` — title case, with a space), so "close
 * enough" would match strings that are provably not this channel's.
 *
 * Every entry needs a live measured handshake AND a consumer. Verified and
 * deliberately NOT mapped:
 *   - `codex-mcp-client` (Codex CLI, live handshake) — the map's only consumer
 *     asks one question, "is this Claude Code?"; an entry no consumer reads is
 *     dead code that looks live and would silently acquire behaviour the day a
 *     second consumer appears.
 *   - `"Visual Studio Code"` (VS Code's built-in client) — static bundle
 *     evidence only, never observed on a live handshake, and the string varies
 *     by edition.
 */
const ATTESTED_HOSTS: ReadonlyMap<string, string> = new Map([
  ["claude-code", "claude-code"],
]);

/**
 * Resolve the handshake identity to a verified host tag, or `undefined`.
 * Positive-only, in every direction: unrecognised, absent, malformed and empty
 * all yield `undefined` — *unknown*, never "not Claude Code". An `undefined`
 * never suppresses anything downstream; it only fails to widen. The notice
 * gate in {@link runEstimateTool} is the sole consumer.
 */
export function attestedHost(
  clientInfo: HandshakeClientInfo | undefined,
): string | undefined {
  const name = clientInfo?.name;
  if (typeof name !== "string") return undefined;
  return ATTESTED_HOSTS.get(name);
}

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
  /**
   * The host's id for THIS tool call, threaded from the MCP request's
   * `params._meta["claudecode/toolUseId"]`. Host-supplied, never model-supplied.
   * Stamped on the pending entry so a LATER estimate can prove which session's
   * transcript this run belongs to. Absent on any host that does not send it —
   * the run is then simply not reconcilable.
   */
  toolUseId?: string;
  /**
   * The connected client's self-declared identity, read from
   * `Server.getClientVersion()` INSIDE the tools/call handler and threaded
   * here — the same host-supplied seam as {@link toolUseId}. `undefined`
   * whenever the SDK has nothing (its return type is
   * `Implementation | undefined` and nothing enforces initialize-first), and
   * absence asserts nothing.
   */
  clientInfo?: HandshakeClientInfo;
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
  // Two different questions, two answers, kept apart on purpose: `host` answers
  // "what did the operator call this install?" — it is the WIRE tag and feeds
  // every existing render — while `noticeHost` answers "what does the host call
  // itself?" and gates exactly one paragraph of text (the hook-less notice
  // below). An explicit BUDGETARY_HOST always wins: it is the only knob the
  // operator has, and an attestation that could override it would be
  // uncorrectable — there would be no way, anywhere, to say "no, this install
  // is not that". The handshake fills only the unset case. And there is
  // deliberately no `?? DEFAULT_HOST` tail: the notice path's "we don't know"
  // is `undefined`, never a manufactured "mcp".
  const noticeHost = args.env.BUDGETARY_HOST ?? attestedHost(args.clientInfo);

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

  // Resolved BEFORE the network call so the binding describes the session that
  // actually made this estimate. Cheap: two env reads and at most two `statSync`
  // calls, no file read and no parse.
  const binding = resolveSessionBinding({
    env: args.env,
    cwd: args.cwd,
    toolUseId: args.toolUseId,
    home: args.home,
  });

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
    // 0024e: the ONE earlier run this estimate may close out, or null. Selected
    // from the snapshot the append already returned — no second file read — and
    // deliberately cheap enough to sit on the interactive path: array filtering
    // plus one liveness check per candidate. Nothing is opened, parsed or posted
    // here; that happens after the response is on its way (see below).
    let candidate: PendingEntry | null = null;
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
        // 0024e: the session binding for THIS run — which transcript measures it
        // and which process is writing it. Resolved from the host environment and
        // the host's own request metadata; the model supplies none of it, and
        // none of it is ever sent on the wire. All four or none: a partial
        // binding cannot be used safely, so `resolveSessionBinding` returns null
        // and the spread contributes nothing (the entry is then exactly what a
        // pre-0024e client would have written).
        ...(binding
          ? {
              session_id: binding.sessionId,
              tool_use_id: binding.toolUseId,
              transcript_dir: binding.transcriptDir,
              owner_pid: binding.ownerPid,
            }
          : {}),
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
        candidate = selectReconcilable({
          entries: result.entries,
          excludeEstimateId: response.estimateId,
          projectId,
          ...(typeof args.env[SESSION_ID_ENV] === "string"
            ? { currentSessionId: args.env[SESSION_ID_ENV] }
            : {}),
          nowMs,
        });
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

    // 0026c: show the measurement of a run whose actuals were submitted earlier.
    //
    // This is the only moment in the product where the measured breakdown can
    // reach a person. The process that receives it cannot show it — a session-end
    // hook's stdout never reaches the user, and the in-process reconcile is
    // scheduled AFTER this response is handed over precisely so it can never
    // delay or fail an interactive call. So the submitting process captures and
    // stays silent, and the next estimate — this one — renders what it captured.
    // The lag is one estimate with a hook installed, two without; that is the
    // correct trade and is not closed by blocking the interactive path.
    //
    // Placed BETWEEN the estimate's own output and the one-time hook-less notice:
    // everything above describes the estimate the user just asked for, and the
    // `─────` notice block stays visually last exactly as it ships today.
    //
    // `claim` is the whole once-per-run mechanism: it marks the record shown and
    // returns it only when that mark actually reached disk, so nothing is ever
    // shown twice and nothing is marked on a run that showed nothing.
    const claimed = new MeasuredStore({
      path: measuredFilePath(args.home),
      logger: { warn: (m) => process.stderr.write(`${m}\n`) },
      ...(args.now !== undefined ? { now: args.now } : {}),
    }).claim(projectId);
    if (claimed !== null) {
      text += `\n\n${measuredLines(claimed.record, {
        recordedEarlier: true,
        otherProject: claimed.otherProject,
      }).join("\n")}`;
    }

    // 0026b-2: ONCE per install, say what leaves this machine.
    //
    // Until now nothing at runtime said it. `claimOneTimeNotice` had exactly one
    // call site — the hook-less notice — and nothing at startup, in `doctor`, or
    // on any other path stated what is transmitted. Everything a user was told
    // about it lived in a README they had no reason to open.
    //
    // ⚠ UNCONDITIONAL on success — not gated on host, not on whether a
    // session-end hook is wired, not on void-vs-priced. Every install can record
    // by hand, and every install reaching this line has already sent a query.
    // That breadth is the whole point: the population that most needs this is
    // the one that configured the server with a bare `claude mcp add` and read
    // nothing else.
    //
    // ⚠ NEVER ON AN ERROR PATH. The claim sits here, on the single successful
    // text return, and LAST — after the text is otherwise built. Burning the
    // marker on a render that goes back as `isError: true` would spend the one
    // disclosure a user whose first estimate fails auth ever gets. The two error
    // returns and the no-key guidance return all sit outside this block and
    // reach it never.
    //
    // ⚠ It fails closed to SILENCE. An unwritable home makes the claim false and
    // nothing renders. That is the right failure — the alternative is a
    // per-estimate nag — and it is the entire argument for stating this
    // unconditionally in `doctor` as well, where it is repeated every run.
    //
    // ⚠ ORDERING: after the measured block, before the `─────` notice. The
    // disclosure says what recording sends; the notice tells the user to wire
    // recording. Instructing before disclosing is the wrong order. On a genuine
    // first run no measured record can exist yet, so the worst case here is four
    // blocks, not five.
    //
    // Existing users see it on their next estimate. That is correct and
    // intended: they have never been shown it.
    if (claimOneTimeNotice(DATA_NOTICE, args.home)) {
      text += `\n\n${dataDisclosureLines().join("\n")}`;
    }

    // ONCE per install: tell a hook-less Claude Code user that this install has
    // no automatic way to submit a completed run. Until now that was silent —
    // `claude mcp add` wires the estimate tool alone, so the user could estimate
    // forever, never contribute, and never be told. A gap nobody mentions is one
    // the user can neither fix nor notice.
    //
    // Narrow on purpose, so the WORKING PATH sees nothing new:
    //   - `claude-code` only — it is the only host with a session-end hook to be
    //     missing. Every other host is manual BY DESIGN and its footer already
    //     says so; adding this there would be noise, not news. Resolved via
    //     `noticeHost` (0024d-3): the operator's declared tag first, else the
    //     handshake's verified attestation — because the population this notice
    //     was written for is definitionally the env-unset one (the plugin's own
    //     manifest sets BUDGETARY_HOST; a bare `claude mcp add` does not). The
    //     other three `claude-code`-gated renders stay on the DECLARED host: a
    //     handshake-detected install provably is not the plugin, so their
    //     non-plugin branches are already the right text for it.
    //   - suppressed by ANY positive sign of an automatic path (see
    //     `contributionStatus`), so an install that can contribute is untouched.
    //   - `claimOneTimeNotice` last, and only if everything else already matched,
    //     so the marker is never burned on a run that would not have shown it.
    //
    // On a VOID TOO — appended BENEATH the void's own message, never in place of
    // it. This block originally carried a `!response.void` gate, reasoning that a
    // void's text stays byte-for-byte what it was (the 0024c rule) and that the
    // notice could simply wait for the next estimate while `doctor` said it
    // unconditionally. Both halves of that fail. Waiting couples two independent
    // things: whether a finished run can be SUBMITTED is a property of how the
    // install is wired, and whether a forecast could be made is a property of the
    // query — the very coupling 0024c removed from the store, left standing on the
    // text. And `doctor` closes nothing, because thinking to run it already
    // requires suspecting the gap the notice exists to disclose.
    //
    // The 0024c rule is about the void's MESSAGE, and that is untouched: the two
    // pending-hygiene nudges above stay `!void`-gated, so everything preceding the
    // separator below is byte-identical to what a void rendered before. The copy
    // needs no rewrite to be true here either — a void stores a pending entry too
    // (0024c), so "nothing will submit this run's real token counts when it
    // finishes" holds exactly as written, and both routes it offers act on that
    // entry (neither requires a forecast band).
    if (
      noticeHost === "claude-code" &&
      contributionStatus(args.env, args.home).kind === "manual-only" &&
      claimOneTimeNotice(HOOKLESS_NOTICE, args.home)
    ) {
      text += `\n\n${hooklessNoticeLines().join("\n")}`;
    }

    // 0024e: close out ONE finished session's estimate, measured from that
    // session's own transcript. Scheduled, never awaited, and never before the
    // response: `setImmediate` runs on a later turn of the event loop, so the
    // MCP SDK has already serialized and written this result by the time any of
    // it executes. The stdio server stays alive while stdin is open, so the work
    // has a live event loop to finish on.
    //
    // The estimate is untouched by all of it. Nothing here can delay the
    // response (it has already been handed over), nothing can change its text
    // (`text` is already built), and nothing can fail it — the module is loaded
    // dynamically so even an import failure lands in the same terminal `.catch`.
    // That catch is a backstop only; `reconcileEntry` is fail-closed throughout.
    // A rejection escaping here would kill the MCP server for the rest of the
    // session under Node's default `--unhandled-rejections=throw`.
    if (candidate !== null) {
      const target = candidate;
      setImmediate(() => {
        void import("../reconcile.js")
          .then((m) =>
            m.reconcileEntry({
              entry: target,
              apiKey: resolved.apiKey,
              baseUrl: resolved.baseUrl,
              env: args.env,
              ...(args.home !== undefined ? { home: args.home } : {}),
              ...(args.now !== undefined ? { now: args.now } : {}),
              ...(args.clientFactory !== undefined
                ? { clientFactory: args.clientFactory }
                : {}),
              logger: { warn: (m2: string) => process.stderr.write(`${m2}\n`) },
            }),
          )
          .catch(() => {});
      });
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
