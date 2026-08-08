import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BudgetaryClient } from "../src/index.js";
import type {
  ActualsResponse,
  Assessment,
  LedgerAssessment,
  LedgerEntry,
  Phases,
} from "../src/index.js";
import {
  TEST_API_KEY,
  TEST_BASE_URL,
  jsonOk,
  jsonStatus,
  startTestServer,
} from "./fixtures/server.js";

/**
 * The measured `phases` / `assessment` blocks (contract §4.2, §4.3) are additive
 * server fields the transport has always passed through — its deep-camelCase walk
 * has no allowlist, so nothing was ever stripped; only the TYPES omitted them.
 * These fixtures pin the round-trip that declaration now describes:
 *
 *  - KEYS are camelCased (`scheme_version` → `schemeVersion`, `burn_share` →
 *    `burnShare`, `total_tokens` → `totalTokens`), with no snake_case survivor;
 *  - VALUES are never transformed — `insufficient_data`, `retry_heavy` and
 *    `insufficient_trace` arrive exactly as sent, and are what a caller switches on;
 *  - the 202's `assessment` is a strict SUBSET: `conversion` / `resolution` are
 *    ABSENT there, not `null`, and absence is not readable as a value;
 *  - a field the server did not send is `undefined`, a field it sent empty is
 *    `null`. Both mean "render silence"; neither is ever a computed guess.
 */

const handle = startTestServer();

beforeAll(() => handle.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => handle.reset());
afterAll(() => handle.server.close());

function newClient() {
  return new BudgetaryClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    maxRetries: 0,
  });
}

function submit(client: BudgetaryClient) {
  return client.submitActuals({
    estimateId: "est_01ABC",
    tokensIn: 12_340,
    tokensOut: 36_210,
    success: true,
    durationMs: 420_000,
    trace: [{ tool: "Read", tokens: 60 }],
  });
}

// ── wire shapes, exactly as docs/api-contract.md documents them ──────────────

const WIRE_PHASES = {
  exploration: { tokens: 14_000, share: 0.288 },
  generation: { tokens: 22_000, share: 0.453 },
  testing: { tokens: 9_550, share: 0.197 },
  retries: { tokens: 3_000, share: 0.062 },
  other: { tokens: 0, share: 0.0 },
  total_tokens: 48_550,
  scheme_version: "phases-v4",
};

/** The 202's four-key assessment: no `conversion`, no `resolution`. */
const WIRE_ASSESSMENT_202 = {
  verdict: "insufficient_data",
  note: null,
  efficiency: { burn_share: 0.062, label: "retry_heavy" },
  scheme_version: "assessment-v4",
};

/** The ledger's fuller assessment: the same four keys plus the two blocks. */
const WIRE_ASSESSMENT_LEDGER = {
  verdict: "normal",
  note: "retry-heavy",
  efficiency: { burn_share: 0.34, label: "insufficient_trace" },
  conversion: {
    produced_changes: 8,
    accepted_changes: 7,
    cost_per_accepted: 6935.7,
    percentile_vs_peers: 0.42,
    verdict: "insufficient_data",
  },
  resolution: {
    external_symbols: 24,
    unresolved_symbols: 0,
    unresolved_rate: 0.0,
    region_rate: 0.021,
    verdict: "insufficient_data",
  },
  scheme_version: "assessment-v4",
};

const WIRE_LEDGER_ENTRY = {
  estimate_id: "est_01",
  created_at: "2026-05-26T03:14:00Z",
  query_excerpt: "fix the flaky test",
  model: "claude-opus-4-7",
  host: "claude-code",
  project_id: "proj_kx7",
  scenario: "confident",
  predicted: { p10: 12_500, p50: 48_000, p90: 220_000 },
  actual: {
    tokens_in: 12_340,
    tokens_out: 36_210,
    total: 48_550,
    duration_ms: 420_000,
    success: true,
  },
  phases: WIRE_PHASES,
  assessment: WIRE_ASSESSMENT_LEDGER,
};

// ── what a caller gets, written against the DECLARED types ───────────────────
// These annotations are the type-level half of the proof: `pnpm typecheck`
// (tsconfig.test.json) fails if any declared field is missing or mis-shaped.

const PHASES: Phases = {
  exploration: { tokens: 14_000, share: 0.288 },
  generation: { tokens: 22_000, share: 0.453 },
  testing: { tokens: 9_550, share: 0.197 },
  retries: { tokens: 3_000, share: 0.062 },
  other: { tokens: 0, share: 0.0 },
  totalTokens: 48_550,
  schemeVersion: "phases-v4",
};

const ASSESSMENT_202: Assessment = {
  verdict: "insufficient_data",
  note: null,
  efficiency: { burnShare: 0.062, label: "retry_heavy" },
  schemeVersion: "assessment-v4",
};

const ASSESSMENT_LEDGER: LedgerAssessment = {
  verdict: "normal",
  note: "retry-heavy",
  efficiency: { burnShare: 0.34, label: "insufficient_trace" },
  conversion: {
    producedChanges: 8,
    acceptedChanges: 7,
    costPerAccepted: 6935.7,
    percentileVsPeers: 0.42,
    verdict: "insufficient_data",
  },
  resolution: {
    externalSymbols: 24,
    unresolvedSymbols: 0,
    unresolvedRate: 0.0,
    regionRate: 0.021,
    verdict: "insufficient_data",
  },
  schemeVersion: "assessment-v4",
};

const LEDGER_ENTRY: LedgerEntry = {
  estimateId: "est_01",
  createdAt: "2026-05-26T03:14:00Z",
  queryExcerpt: "fix the flaky test",
  model: "claude-opus-4-7",
  host: "claude-code",
  projectId: "proj_kx7",
  scenario: "confident",
  predicted: { p10: 12_500, p50: 48_000, p90: 220_000 },
  actual: {
    tokensIn: 12_340,
    tokensOut: 36_210,
    total: 48_550,
    durationMs: 420_000,
    success: true,
  },
  phases: PHASES,
  assessment: ASSESSMENT_LEDGER,
};

/** Keys of a parsed block, for asserting no snake_case survivor lingers. */
function keys(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

describe("POST /v1/actuals — phases/assessment on the 202", () => {
  it("round-trips both blocks: keys camelCased, values untouched", async () => {
    handle.use(
      jsonStatus("/v1/actuals", 202, {
        received: true,
        ledger_entry_id: "led_999",
        phases: WIRE_PHASES,
        assessment: WIRE_ASSESSMENT_202,
      }),
    );

    const res: ActualsResponse = await submit(newClient());

    expect(res.received).toBe(true);
    expect(res.ledgerEntryId).toBe("led_999");
    expect(res.phases).toEqual(PHASES);
    expect(res.assessment).toEqual(ASSESSMENT_202);

    // KEYS are mapped, and the snake_case originals do not linger.
    expect(keys(res.phases)).toEqual([
      "exploration",
      "generation",
      "other",
      "retries",
      "schemeVersion",
      "testing",
      "totalTokens",
    ]);
    const efficiency = res.assessment?.efficiency as object;
    expect(keys(efficiency)).toEqual(["burnShare", "label"]);
    for (const snake of ["total_tokens", "scheme_version"]) {
      expect(snake in (res.phases as object)).toBe(false);
    }
    expect("burn_share" in efficiency).toBe(false);

    // VALUES are not transformed — an underscored value is a server label, not a key.
    expect(res.assessment?.verdict).toBe("insufficient_data");
    expect(res.assessment?.verdict).not.toBe("insufficientData");
    expect(res.assessment?.efficiency?.label).toBe("retry_heavy");
    expect(res.assessment?.efficiency?.label).not.toBe("retryHeavy");
    expect(res.phases?.schemeVersion).toBe("phases-v4");
    expect(res.assessment?.schemeVersion).toBe("assessment-v4");
  });

  it("carries EXACTLY four assessment keys — conversion/resolution absent, not null", async () => {
    handle.use(
      jsonStatus("/v1/actuals", 202, {
        received: true,
        ledger_entry_id: "led_998",
        phases: WIRE_PHASES,
        assessment: WIRE_ASSESSMENT_202,
      }),
    );

    const res = await submit(newClient());

    expect(keys(res.assessment)).toEqual([
      "efficiency",
      "note",
      "schemeVersion",
      "verdict",
    ]);
    // Absent, NOT present-and-null: absence must not be readable as a value.
    expect("conversion" in (res.assessment as object)).toBe(false);
    expect("resolution" in (res.assessment as object)).toBe(false);

    // ...and the declaration enforces that: the 202's `Assessment` has no
    // `conversion` to read, so this line must NOT type-check. `pnpm typecheck`
    // fails if the error ever stops being raised.
    // @ts-expect-error — `conversion` is served only on GET /v1/ledger.
    const unreadable: unknown = res.assessment?.conversion;
    expect(unreadable).toBeUndefined();
  });

  it("is undefined on a 202 that carries neither block (older deployment → silence)", async () => {
    handle.use(
      jsonStatus("/v1/actuals", 202, {
        received: true,
        ledger_entry_id: "led_bare",
      }),
    );

    const res = await submit(newClient());

    expect(res.ledgerEntryId).toBe("led_bare");
    expect(res.phases).toBeUndefined();
    expect(res.assessment).toBeUndefined();
    expect("phases" in (res as object)).toBe(false);
    expect("assessment" in (res as object)).toBe(false);
  });

  it("preserves an explicit null (server answered, nothing to give)", async () => {
    handle.use(
      jsonStatus("/v1/actuals", 202, {
        received: true,
        ledger_entry_id: "led_null",
        phases: null,
        assessment: null,
      }),
    );

    const res = await submit(newClient());

    // `null` (sent, empty) stays distinguishable from `undefined` (never sent).
    expect(res.phases).toBeNull();
    expect(res.assessment).toBeNull();
  });
});

describe("GET /v1/ledger — phases/assessment on an entry", () => {
  it("round-trips the fuller ledger shape, including conversion/resolution", async () => {
    handle.use(
      jsonOk("/v1/ledger", {
        entries: [WIRE_LEDGER_ENTRY],
        next_cursor: null,
      }),
    );

    const page = await newClient().getLedger();
    const entry = page.entries[0]!;

    expect(entry).toEqual(LEDGER_ENTRY);
    expect(entry.phases).toEqual(PHASES);
    expect(entry.assessment).toEqual(ASSESSMENT_LEDGER);

    // The two ledger-only blocks are declared and key-mapped.
    expect(keys(entry.assessment?.conversion)).toEqual([
      "acceptedChanges",
      "costPerAccepted",
      "percentileVsPeers",
      "producedChanges",
      "verdict",
    ]);
    expect(keys(entry.assessment?.resolution)).toEqual([
      "externalSymbols",
      "regionRate",
      "unresolvedRate",
      "unresolvedSymbols",
      "verdict",
    ]);
    expect(entry.assessment?.conversion?.costPerAccepted).toBe(6935.7);
    expect(entry.assessment?.resolution?.regionRate).toBe(0.021);

    // VALUES untransformed here too.
    expect(entry.assessment?.conversion?.verdict).toBe("insufficient_data");
    expect(entry.assessment?.resolution?.verdict).toBe("insufficient_data");
    expect(entry.assessment?.efficiency?.label).toBe("insufficient_trace");
    expect(entry.phases?.totalTokens).toBe(48_550);
  });

  it("preserves null phases/assessment on an entry (no trace / no actual yet)", async () => {
    handle.use(
      jsonOk("/v1/ledger", {
        entries: [
          { ...WIRE_LEDGER_ENTRY, actual: null, phases: null, assessment: null },
        ],
        next_cursor: null,
      }),
    );

    const entry = (await newClient().getLedger()).entries[0]!;

    expect(entry.actual).toBeNull();
    expect(entry.phases).toBeNull();
    expect(entry.assessment).toBeNull();
  });

  it("is undefined on an entry that carries neither block", async () => {
    const { phases, assessment, ...bare } = WIRE_LEDGER_ENTRY;
    expect(phases).toBeDefined();
    expect(assessment).toBeDefined();

    handle.use(jsonOk("/v1/ledger", { entries: [bare], next_cursor: null }));

    const entry = (await newClient().getLedger()).entries[0]!;

    expect(entry.estimateId).toBe("est_01");
    expect(entry.phases).toBeUndefined();
    expect(entry.assessment).toBeUndefined();
  });
});

describe("the 202's assessment is a strict subset of the ledger's", () => {
  it("assigns a LedgerAssessment where an Assessment is expected", () => {
    // Type-level (checked by `pnpm typecheck`): the ledger shape satisfies the
    // 202 shape, so one renderer can read either. The reverse must not hold.
    const asSubset: Assessment = ASSESSMENT_LEDGER;
    expect(asSubset.verdict).toBe("normal");
    expect(asSubset.schemeVersion).toBe(ASSESSMENT_LEDGER.schemeVersion);

    // @ts-expect-error — an `Assessment` is missing nothing, but it declares no
    // `conversion`/`resolution`, so it cannot stand in for a `LedgerAssessment`
    // read. (Absence is not a value; a caller must not invent one.)
    const nope: unknown = ASSESSMENT_202.conversion;
    expect(nope).toBeUndefined();
  });
});
