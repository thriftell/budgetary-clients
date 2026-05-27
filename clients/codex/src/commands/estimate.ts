// Adapted from clients/claude-code/src/commands/estimate.ts. The only
// behavioral difference is `context.host = "codex"`.
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { Writable } from "node:stream";

import {
  BudgetaryClient,
  BudgetaryError,
  type BudgetaryClientOptions,
  type EstimateResponse,
} from "@budgetary/sdk";

import {
  noKeyHint,
  pendingFilePath,
  resolveApiKey,
  type ConfigEnv,
} from "../config.js";
import { renderEstimate, renderSdkError } from "../format.js";
import { PendingStore, type PendingEntry } from "../store.js";

export interface EstimateInvocation {
  query: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  /** Override the SDK client (tests). */
  clientFactory?: (opts: BudgetaryClientOptions) => BudgetaryClient;
  /** Override the now timestamp (tests). */
  now?: () => Date;
  /** Override the home dir for ~/.budgetary (tests). */
  home?: string;
}

export function projectIdFromCwd(cwd: string): string {
  const abs = resolvePath(cwd);
  return createHash("sha256").update(abs).digest("hex").slice(0, 16);
}

export async function runEstimate(args: EstimateInvocation): Promise<number> {
  const configEnv: ConfigEnv = { env: args.env, home: args.home };

  if (args.query.length === 0) {
    args.stderr.write("Budgetary: /estimate requires a task description.\n");
    return 2;
  }

  const resolved = resolveApiKey(configEnv);
  if (resolved === null) {
    args.stdout.write(`${noKeyHint()}\n`);
    return 0;
  }

  const factory =
    args.clientFactory ?? ((opts: BudgetaryClientOptions) => new BudgetaryClient(opts));
  const client = factory({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
  });

  const projectId = projectIdFromCwd(args.cwd);
  let response: EstimateResponse;
  try {
    response = await client.estimate(args.query, {
      context: { host: "codex", projectId },
    });
  } catch (err) {
    if (err instanceof BudgetaryError) {
      args.stderr.write(`${renderSdkError(err.message, err.requestId)}\n`);
      return 1;
    }
    args.stderr.write(
      `Budgetary error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  args.stdout.write(`${renderEstimate(response)}\n`);

  if (!response.void) {
    const store = new PendingStore({ path: pendingFilePath(configEnv) });
    const entry: PendingEntry = {
      estimate_id: response.estimateId,
      query: args.query,
      project_id: projectId,
      created_at: (args.now ?? (() => new Date()))().toISOString(),
      attempts: 0,
    };
    store.append(entry);
  }

  return 0;
}
