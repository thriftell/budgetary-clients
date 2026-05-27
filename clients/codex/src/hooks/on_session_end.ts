// Adapted from clients/claude-code/src/hooks/on_session_end.ts. Control flow
// is identical; only the payload field reads differ.
//
// Codex's Stop hook payload (per codex-rs/hooks/schema/generated/stop.command.input.schema.json):
//   { session_id, turn_id, transcript_path, cwd, hook_event_name: "Stop",
//     model, permission_mode, stop_hook_active, last_assistant_message }
//
// Notably: no token totals (same as Claude Code's SessionEnd). We re-parse the
// rollout JSONL at `transcript_path`. There is also no explicit "reason"
// field; success is inferred from `last_assistant_message !== null`
// (a clean stop produces a final assistant message).
import { Writable } from "node:stream";

import {
  BudgetaryClient,
  BudgetaryError,
  type BudgetaryClientOptions,
} from "@budgetary/sdk";

import {
  pendingFilePath,
  resolveApiKey,
  type ConfigEnv,
} from "../config.js";
import { PendingStore, type PendingEntry } from "../store.js";
import { readTranscriptTotals } from "../transcript.js";

export interface StopPayload {
  session_id?: string;
  turn_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
  // Future / unknown fields are ignored.
  [key: string]: unknown;
}

export interface SessionEndInvocation {
  payload: StopPayload | null;
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
const MAX_ATTEMPTS = 5;

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

  const success = isSuccessfulStop(args.payload);
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

  try {
    await client.submitActuals({
      estimateId: newest.estimate_id,
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      success,
      durationMs,
    });
    file.entries.pop();
    store.write(file);
    return 0;
  } catch (err) {
    const updated: PendingEntry = { ...newest, attempts: newest.attempts + 1 };
    if (updated.attempts >= MAX_ATTEMPTS) {
      file.entries.pop();
      store.write(file);
      const detail = err instanceof BudgetaryError ? err.message : String(err);
      args.stderr.write(
        `Budgetary: giving up on actuals for ${newest.estimate_id} after ${MAX_ATTEMPTS} attempts (${detail}).\n`,
      );
      return 0;
    }
    file.entries[file.entries.length - 1] = updated;
    store.write(file);
    return 0;
  }
}

function isSuccessfulStop(payload: StopPayload): boolean {
  // The Stop schema does not include a "reason" field. The closest signal:
  // a clean stop produces a final assistant message; a crashed / interrupted
  // turn does not. Treat present-and-non-empty as success.
  const msg = payload.last_assistant_message;
  return typeof msg === "string" && msg.length > 0;
}

function inferDurationMs(
  payload: StopPayload,
  pending: PendingEntry,
  now: Date,
): number {
  // The Stop payload doesn't expose start/end timestamps, so fall back to
  // (now - pending.created_at). This upper-bounds the real session duration.
  // If a future Codex release adds `started_at`, this picks it up.
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
