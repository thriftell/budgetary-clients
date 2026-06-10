import { Writable } from "node:stream";

import {
  BudgetaryClient,
  type BudgetaryClientOptions,
} from "@budgetary/sdk";
// The submit/retry/cap logic is shared with the MCP client so every host
// closes actuals through one code path that never accepts model-supplied counts.
import { submitActuals } from "@budgetary/mcp/actuals";

import {
  pendingFilePath,
  resolveApiKey,
  type ConfigEnv,
} from "../config.js";
import { PendingStore, type PendingEntry } from "../store.js";
import { readTranscriptTotals } from "../transcript.js";

export interface SessionEndPayload {
  session_id?: string;
  transcript_path?: string;
  reason?: string;
  // Some Claude Code versions may include richer fields; we ignore unknowns.
  [key: string]: unknown;
}

export interface SessionEndInvocation {
  payload: SessionEndPayload | null;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
  now?: () => Date;
  home?: string;
  /** Override transcript-totals reader (tests). */
  readTotals?: (path: string) => { tokensIn: number; tokensOut: number } | null;
}

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export async function runOnSessionEnd(args: SessionEndInvocation): Promise<number> {
  const configEnv: ConfigEnv = { env: args.env, home: args.home };
  const path = pendingFilePath(configEnv);
  const store = new PendingStore({
    path,
    logger: { warn: (m) => args.stderr.write(`${m}\n`) },
  });
  const file = store.read();
  if (file.entries.length === 0) return 0;

  const newest = file.entries[file.entries.length - 1]!;
  const now = (args.now ?? (() => new Date()))();
  const created = Date.parse(newest.created_at);
  if (!Number.isFinite(created) || now.getTime() - created > PENDING_TTL_MS) {
    file.entries.pop();
    store.write(file);
    return 0;
  }

  if (args.payload === null) return 0;
  const transcriptPath = typeof args.payload.transcript_path === "string"
    ? args.payload.transcript_path
    : null;
  if (transcriptPath === null) return 0;

  const totals = (args.readTotals ?? readTranscriptTotals)(transcriptPath);
  if (totals === null) return 0;

  const success = isSuccessReason(args.payload.reason);
  const durationMs = inferDurationMs(args.payload, newest, now);

  const resolved = resolveApiKey(configEnv);
  if (resolved === null) {
    // No key — leave the entry in place for a later session that has one.
    return 0;
  }

  const factory =
    args.clientFactory ?? ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  const client = factory({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
  });

  // Real, transcript-derived counts only — routed through the shared submit
  // helper in @budgetary/mcp so the on-success removal, attempts increment,
  // and drop-after-5 behavior is identical across every Budgetary host.
  await submitActuals({
    store,
    file,
    client,
    entry: newest,
    counts: {
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      success,
      durationMs,
    },
    logger: { warn: (m) => args.stderr.write(`${m}\n`) },
  });
  return 0;
}

function isSuccessReason(reason: unknown): boolean {
  // Treat documented "normal" termination reasons as success; anything else
  // (e.g. "other" with a crash) as failure. Conservative: when unknown,
  // default to false rather than over-claiming success.
  return reason === "clear" || reason === "logout" || reason === "prompt_input_exit";
}

function inferDurationMs(
  payload: SessionEndPayload,
  pending: PendingEntry,
  now: Date,
): number {
  // The SessionEnd payload doesn't currently expose start/end timestamps,
  // so fall back to (now - pending.created_at). This is an upper bound on
  // the real session duration but it's the best signal we have.
  const startMs =
    typeof payload.started_at === "string" ? Date.parse(payload.started_at) : NaN;
  if (Number.isFinite(startMs)) {
    return Math.max(0, now.getTime() - startMs);
  }
  const createdMs = Date.parse(pending.created_at);
  if (Number.isFinite(createdMs)) {
    return Math.max(0, now.getTime() - createdMs);
  }
  return 0;
}
