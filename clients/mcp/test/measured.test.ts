import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActualsResponse,
  Assessment,
  EstimateResponse,
  LedgerPage,
  Phases,
} from "@budgetary/sdk";

import {
  runAutoActuals,
  runManualActuals,
  runRolloutActuals,
  submitActuals,
} from "../src/actuals.js";
import { measuredFilePath } from "../src/config.js";
import {
  claimOneTimeNotice,
  DATA_NOTICE,
  hooklessNoticeLines,
} from "../src/contribution.js";
import { measuredLines } from "../src/format.js";
import {
  MAX_MEASURED_RECORDS,
  MeasuredStore,
  summaryFromActualsResponse,
  type MeasuredFile,
  type MeasuredSummary,
} from "../src/measured.js";
import { reconcileEntry } from "../src/reconcile.js";
import { TOOLS } from "../src/server.js";
import { PendingStore, type PendingEntry, type PendingStoreFile } from "../src/store.js";
import { projectIdFromCwd, runEstimateTool } from "../src/tools/estimate.js";

// ---------------------------------------------------------------------------
// Fixtures. Every payload below is TRANSCRIBED from the shape the server sends
// (contract §4.2): snake_case on the wire, camelCased by the SDK's transport,
// values never transformed. Nothing here is built by calling the code under test.
// ---------------------------------------------------------------------------

const PHASES: Phases = {
  exploration: { tokens: 14000, share: 0.288 },
  generation: { tokens: 20000, share: 0.412 },
  testing: { tokens: 6000, share: 0.124 },
  retries: { tokens: 6550, share: 0.135 },
  other: { tokens: 2000, share: 0.041 },
  totalTokens: 48550,
  schemeVersion: "phases-v4",
};

const ASSESSMENT: Assessment = {
  verdict: "insufficient_data",
  note: null,
  efficiency: { burnShare: 0.176, label: "retry_heavy" },
  schemeVersion: "assessment-v4",
};

/** A 202 body from a deployment that computes the summary. */
function measuredResponse(over: Partial<ActualsResponse> = {}): ActualsResponse {
  return {
    received: true,
    ledgerEntryId: "led_01HZZ",
    phases: PHASES,
    assessment: ASSESSMENT,
    ...over,
  };
}

/** A 202 body from a deployment that predates 0026c-1: no such fields at all. */
function legacyResponse(): ActualsResponse {
  return { received: true, ledgerEntryId: "led_01HZZ" };
}

interface FakeClient {
  estimate: ReturnType<typeof vi.fn>;
  submitActuals: ReturnType<typeof vi.fn>;
  getLedger: ReturnType<typeof vi.fn>;
}

function makeFakeClient(
  submitImpl: () => Promise<ActualsResponse> = async () => measuredResponse(),
  estimateImpl?: () => Promise<EstimateResponse>,
): FakeClient {
  return {
    estimate: vi.fn(
      estimateImpl ??
        (async (): Promise<EstimateResponse> => ({
          estimateId: "est_new",
          scenario: "confident",
          void: false,
          distribution: { p10: 1000, p50: 4000, p90: 20000, unit: "tokens" },
          confidence: 0.7,
          model: "claude-opus-4-7",
          expiresAt: "2026-08-10T10:00:00Z",
        })),
    ),
    submitActuals: vi.fn(submitImpl),
    getLedger: vi.fn(
      async (): Promise<LedgerPage> => ({ entries: [], nextCursor: null }),
    ),
  };
}

const asClient = (fake: FakeClient) =>
  fake as unknown as import("@budgetary/sdk").BudgetaryClient;

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-measured-"));
  cwd = mkdtempSync(join(tmpdir(), "budgetary-measured-cwd-"));
  mkdirSync(join(home, ".budgetary"), { recursive: true });
  // Spend the first-run data disclosure's marker before any test runs (0026b-2).
  // Every `home` here is a fresh temp dir, so without this EVERY first estimate
  // in this file would carry that once-per-install block and every whole-output
  // golden below would be re-asserting it. This file's subject is the MEASURED
  // block and the ordering around it; the disclosure is a separate once-only
  // thing that would only add noise to each expectation.
  //
  // It is exactly the trick the `CC` env below already plays on the OTHER
  // once-only block — declaring a session-end hook to suppress the hook-less
  // notice so those cases isolate their subject. The disclosure has no env
  // switch, so its marker is spent directly. Its own behaviour (fires once, on
  // success only, never on an error path) is proven on genuinely fresh homes in
  // `disclosure.test.ts`.
  claimOneTimeNotice(DATA_NOTICE, home);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    chmodSync(join(home, ".budgetary"), 0o700);
  } catch {
    // already gone / already writable
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const ENV = { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv;
const NOW = new Date("2026-08-09T10:14:00Z");
const RECENT = "2026-08-09T10:00:00Z";

function writePending(file: PendingStoreFile) {
  writeFileSync(
    join(home, ".budgetary", "pending.json"),
    JSON.stringify(file),
    "utf8",
  );
}

function readMeasuredFile(): MeasuredFile | null {
  try {
    return JSON.parse(readFileSync(measuredFilePath(home), "utf8")) as MeasuredFile;
  } catch {
    return null;
  }
}

function store(now: () => Date = () => NOW): MeasuredStore {
  return new MeasuredStore({ path: measuredFilePath(home), now });
}

function summary(over: Partial<MeasuredSummary> = {}): MeasuredSummary {
  return {
    estimate_id: "est_01ABCDEF2345",
    project_id: "proj_a",
    phases: PHASES,
    assessment: ASSESSMENT,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The buffer file — separate from pending.json, capped, TTL'd, validated on read
// ---------------------------------------------------------------------------

describe("MeasuredStore — the buffer", () => {
  it("lives in its OWN file, never in the pending store", () => {
    // pending.json's loader rebuilds the file as `{version, entries}` and drops
    // every unrecognised top-level key, on load and therefore on every
    // write-back — a summary parked there would vanish with no error. This is
    // the whole reason for a second file, so it is pinned rather than assumed.
    store().record(summary());
    expect(measuredFilePath(home)).toBe(join(home, ".budgetary", "measured.json"));
    expect(existsSync(measuredFilePath(home))).toBe(true);
    // The pending store is untouched by a capture.
    expect(existsSync(join(home, ".budgetary", "pending.json"))).toBe(false);
  });

  it("writes owner-only, like everything else under ~/.budgetary", () => {
    store().record(summary());
    expect(statSync(measuredFilePath(home)).mode & 0o777).toBe(0o600);
  });

  it("stores the server's blocks verbatim — no re-keying, no re-derivation", () => {
    store().record(summary());
    const file = readMeasuredFile()!;
    expect(file.version).toBe(1);
    expect(file.records).toHaveLength(1);
    expect(file.records[0]!.phases).toEqual(PHASES);
    expect(file.records[0]!.assessment).toEqual(ASSESSMENT);
    expect(file.records[0]!.estimate_id).toBe("est_01ABCDEF2345");
    expect(file.records[0]!.captured_at).toBe(NOW.toISOString());
  });

  it("keeps at most 5 records, dropping the oldest", () => {
    const s = store();
    for (let i = 0; i < MAX_MEASURED_RECORDS + 3; i++) {
      s.record(summary({ estimate_id: `est_${i}` }));
    }
    const ids = readMeasuredFile()!.records.map((r) => r.estimate_id);
    expect(ids).toEqual(["est_3", "est_4", "est_5", "est_6", "est_7"]);
  });

  it("drops records past the 7-day TTL and never shows them", () => {
    store(() => new Date("2026-08-01T10:00:00Z")).record(summary({ estimate_id: "est_old" }));
    // 8 days later.
    const later = store(() => new Date("2026-08-09T10:00:00Z"));
    expect(later.read()).toEqual([]);
    expect(later.claim("proj_a")).toBeNull();
  });

  it("keeps a record whose captured_at is unparseable or in the future (unknown age)", () => {
    writeFileSync(
      measuredFilePath(home),
      JSON.stringify({
        version: 1,
        records: [
          { ...summary({ estimate_id: "est_bad" }), captured_at: "not-a-date" },
          { ...summary({ estimate_id: "est_future" }), captured_at: "2099-01-01T00:00:00Z" },
        ],
      }),
      "utf8",
    );
    expect(store().read().map((r) => r.estimate_id)).toEqual(["est_bad", "est_future"]);
  });

  it("REPLACES a re-captured estimate_id instead of queueing a duplicate", () => {
    // `report-actual --estimate-id` against an already-recorded run is an
    // idempotent replay: the server returns the same summary again. Without
    // replacement the same breakdown would be shown twice.
    const s = store();
    s.record(summary());
    s.record(summary({ assessment: { ...ASSESSMENT, verdict: "normal" } }));
    const records = readMeasuredFile()!.records;
    expect(records).toHaveLength(1);
    expect(records[0]!.assessment.verdict).toBe("normal");
  });

  it("a replay does NOT un-show an already-shown record, and does not extend its TTL", () => {
    const s = store();
    s.record(summary());
    expect(s.claim("proj_a")).not.toBeNull();
    // Same id captured again, an hour later.
    new MeasuredStore({
      path: measuredFilePath(home),
      now: () => new Date("2026-08-09T11:14:00Z"),
    }).record(summary());
    const records = readMeasuredFile()!.records;
    expect(records).toHaveLength(1);
    expect(records[0]!.shown).toBe(true);
    expect(records[0]!.captured_at).toBe(NOW.toISOString()); // the ORIGINAL stamp
    expect(store().claim("proj_a")).toBeNull(); // and it is never shown again
  });

  it("drops a corrupt or unparseable buffer to empty — never a crash", () => {
    for (const bytes of ["{not json", "[]", '{"version":2,"records":[]}', '{"records":"x"}']) {
      writeFileSync(measuredFilePath(home), bytes, "utf8");
      expect(store().read()).toEqual([]);
      expect(store().claim("proj_a")).toBeNull();
      // And the next capture repairs the file rather than failing.
      store().record(summary());
      expect(store().read()).toHaveLength(1);
    }
  });

  it("drops malformed RECORDS but keeps the valid ones", () => {
    writeFileSync(
      measuredFilePath(home),
      JSON.stringify({
        version: 1,
        records: [
          { estimate_id: "", captured_at: RECENT, assessment: ASSESSMENT }, // no id
          { estimate_id: "est_x", captured_at: RECENT }, // no assessment
          { estimate_id: "est_y", captured_at: RECENT, assessment: { note: null } }, // no verdict
          { estimate_id: "est_ok", captured_at: RECENT, assessment: ASSESSMENT },
        ],
      }),
      "utf8",
    );
    expect(store().read().map((r) => r.estimate_id)).toEqual(["est_ok"]);
  });

  it("degrades a malformed phases block to silence, keeping the verdict", () => {
    // A partial breakdown is not a smaller breakdown — the shares would no
    // longer account for the total. All-or-nothing, and the assessment survives.
    writeFileSync(
      measuredFilePath(home),
      JSON.stringify({
        version: 1,
        records: [
          {
            estimate_id: "est_p",
            captured_at: RECENT,
            assessment: ASSESSMENT,
            phases: { ...PHASES, testing: { tokens: 1 } },
          },
        ],
      }),
      "utf8",
    );
    const record = store().read()[0]!;
    expect(record.phases).toBeNull();
    expect(record.assessment.verdict).toBe("insufficient_data");
  });

  it("never throws when ~/.budgetary cannot be written", () => {
    chmodSync(join(home, ".budgetary"), 0o500);
    expect(() => store().record(summary())).not.toThrow();
    // Nothing was captured, so nothing is claimable — silence, not a crash.
    expect(store().claim("proj_a")).toBeNull();
    chmodSync(join(home, ".budgetary"), 0o700);
  });
});

// ---------------------------------------------------------------------------
// claim — the once-per-run rule and the project scoping
// ---------------------------------------------------------------------------

describe("MeasuredStore.claim", () => {
  it("returns a record once, then never again", () => {
    store().record(summary());
    expect(store().claim("proj_a")!.record.estimate_id).toBe("est_01ABCDEF2345");
    expect(store().claim("proj_a")).toBeNull();
    expect(store().claim("proj_a")).toBeNull();
  });

  it("marks the record shown ON DISK, so a second process cannot re-show it", () => {
    store().record(summary());
    store().claim("proj_a");
    expect(readMeasuredFile()!.records[0]!.shown).toBe(true);
  });

  it("writes NOTHING when there is nothing to show", () => {
    // No marker may be burned on a run that showed nothing. With an empty buffer
    // the claim must not even create the file.
    expect(store().claim("proj_a")).toBeNull();
    expect(existsSync(measuredFilePath(home))).toBe(false);

    // And with a fully-shown buffer, the bytes are left exactly as they were.
    store().record(summary());
    store().claim("proj_a");
    const before = readFileSync(measuredFilePath(home), "utf8");
    expect(store().claim("proj_a")).toBeNull();
    expect(readFileSync(measuredFilePath(home), "utf8")).toBe(before);
  });

  it("shows NOTHING when the shown-mark cannot be persisted", () => {
    // Fails toward silence, exactly like the one-time notice marker: the one
    // thing worse than a delayed summary is one that reappears on every estimate.
    store().record(summary());
    chmodSync(join(home, ".budgetary"), 0o500);
    expect(store().claim("proj_a")).toBeNull();
    chmodSync(join(home, ".budgetary"), 0o700);
  });

  it("prefers THIS project's summary over another project's", () => {
    const s = store();
    s.record(summary({ estimate_id: "est_other", project_id: "proj_b" }));
    s.record(summary({ estimate_id: "est_mine", project_id: "proj_a" }));
    // Newest-first would pick est_mine anyway; put the foreign one last to prove
    // the project filter, not the ordering, is what selects.
    s.record(summary({ estimate_id: "est_other2", project_id: "proj_b" }));
    const claim = store().claim("proj_a")!;
    expect(claim.record.estimate_id).toBe("est_mine");
    expect(claim.otherProject).toBe(false);
  });

  it("falls back to another project's summary rather than losing it", () => {
    store().record(summary({ estimate_id: "est_other", project_id: "proj_b" }));
    const claim = store().claim("proj_a")!;
    expect(claim.record.estimate_id).toBe("est_other");
    expect(claim.otherProject).toBe(true);
  });

  it("never CLAIMS a different project when the answer is unknown", () => {
    // A record with no project (the `report-actual --estimate-id` path writes
    // one) is not evidence of a different project, so the qualifier stays off.
    store().record(summary({ estimate_id: "est_noproj", project_id: undefined }));
    expect(store().claim("proj_a")!.otherProject).toBe(false);
    store().record(summary({ estimate_id: "est_2", project_id: "proj_a" }));
    expect(store().claim(null)!.otherProject).toBe(false);
  });

  it("claims the NEWEST unshown record within a project", () => {
    const s = store();
    s.record(summary({ estimate_id: "est_1" }));
    s.record(summary({ estimate_id: "est_2" }));
    expect(store().claim("proj_a")!.record.estimate_id).toBe("est_2");
    expect(store().claim("proj_a")!.record.estimate_id).toBe("est_1");
    expect(store().claim("proj_a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// summaryFromActualsResponse — fail closed to silence, with no version check
// ---------------------------------------------------------------------------

describe("summaryFromActualsResponse", () => {
  const entry = { estimate_id: "est_1", project_id: "proj_a" };

  it("captures the summary a 0026c-1 deployment returns", () => {
    expect(summaryFromActualsResponse(measuredResponse(), entry)).toEqual({
      estimate_id: "est_1",
      project_id: "proj_a",
      phases: PHASES,
      assessment: ASSESSMENT,
    });
  });

  it("captures NOTHING from an older deployment's 202", () => {
    expect(summaryFromActualsResponse(legacyResponse(), entry)).toBeNull();
  });

  it("captures nothing when the server computed none (assessment: null)", () => {
    expect(
      summaryFromActualsResponse(measuredResponse({ assessment: null }), entry),
    ).toBeNull();
  });

  it("keeps the verdict when the server sent no breakdown (phases: null)", () => {
    // A run submitted without a trace: the verdict stands, the breakdown is
    // silence. `null` is never read as a value, and nothing is computed for it.
    const s = summaryFromActualsResponse(measuredResponse({ phases: null }), entry)!;
    expect(s.phases).toBeNull();
    expect(s.assessment.verdict).toBe("insufficient_data");
  });

  it("keeps an UNRECOGNIZED verdict exactly as received", () => {
    const s = summaryFromActualsResponse(
      measuredResponse({ assessment: { ...ASSESSMENT, verdict: "some_new_label" } }),
      entry,
    )!;
    expect(s.assessment.verdict).toBe("some_new_label");
  });

  it("drops a garbage body rather than throwing", () => {
    for (const body of [null, undefined, "text", 42, {}, { assessment: 7 }]) {
      expect(summaryFromActualsResponse(body, entry)).toBeNull();
    }
  });

  it("never invents a value for a missing sub-field", () => {
    const s = summaryFromActualsResponse(
      measuredResponse({
        assessment: { verdict: "normal" } as unknown as Assessment,
        phases: undefined,
      }),
      entry,
    )!;
    expect(s.assessment.note).toBeNull();
    expect(s.assessment.efficiency).toBeNull();
    expect(s.phases).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The render — every displayed value is a server field
// ---------------------------------------------------------------------------

describe("measuredLines", () => {
  it("renders the breakdown first, then the verdict, then the composition", () => {
    expect(measuredLines(summary(), { recordedEarlier: true })).toEqual([
      "Measured breakdown for est_01ABCDEF… (a run recorded earlier):",
      "exploration 29% · generation 41% · testing 12% · retries 14% · other 4%",
      "48,550 tokens measured",
      "Was that normal for a task like this? insufficient_data",
      "Composition: retry_heavy (burn share 18%)",
    ]);
  });

  it("drops the 'recorded earlier' framing on the submit path", () => {
    expect(measuredLines(summary(), { recordedEarlier: false })[0]).toBe(
      "Measured breakdown for est_01ABCDEF…:",
    );
  });

  it("says so when the summary comes from a different project directory", () => {
    expect(
      measuredLines(summary(), { recordedEarlier: true, otherProject: true })[0],
    ).toBe(
      "Measured breakdown for est_01ABCDEF… (a run recorded earlier in a different project directory):",
    );
  });

  it("ALWAYS prints the estimate id — the misattribution defense", () => {
    for (const opts of [
      { recordedEarlier: true },
      { recordedEarlier: false },
      { recordedEarlier: true, otherProject: true },
    ]) {
      for (const s of [summary(), summary({ phases: null }), summary({ assessment: { ...ASSESSMENT, efficiency: null } })]) {
        expect(measuredLines(s, opts)[0]).toContain("est_01ABCDEF…");
      }
    }
  });

  it("prints the phase names in the payload's own order, never by size", () => {
    const line = measuredLines(summary(), { recordedEarlier: true })[1]!;
    expect(line).toBe(
      "exploration 29% · generation 41% · testing 12% · retries 14% · other 4%",
    );
    // `generation` is the largest share and is still second — nothing is ranked.
    expect(line.indexOf("exploration")).toBeLessThan(line.indexOf("generation"));
  });

  it("renders an absent breakdown as SILENCE — no line, no em-dash, no guess", () => {
    for (const phases of [null, undefined]) {
      expect(measuredLines(summary({ phases }), { recordedEarlier: true })).toEqual([
        "Measured breakdown for est_01ABCDEF… (a run recorded earlier):",
        "Was that normal for a task like this? insufficient_data",
        "Composition: retry_heavy (burn share 18%)",
      ]);
    }
  });

  it("renders an absent efficiency as silence — composition cannot be inferred", () => {
    const lines = measuredLines(
      summary({ assessment: { ...ASSESSMENT, efficiency: null } }),
      { recordedEarlier: true },
    );
    expect(lines.some((l) => l.startsWith("Composition:"))).toBe(false);
    expect(lines).toContain("Was that normal for a task like this? insufficient_data");
  });

  it("prints an UNRECOGNIZED verdict and label as received", () => {
    const lines = measuredLines(
      summary({
        assessment: {
          verdict: "some_new_verdict",
          note: null,
          efficiency: { burnShare: 0.5, label: "some_new_label" },
          schemeVersion: "assessment-v9",
        },
      }),
      { recordedEarlier: true },
    );
    expect(lines).toContain("Was that normal for a task like this? some_new_verdict");
    expect(lines).toContain("Composition: some_new_label (burn share 50%)");
  });

  it("appends the server's note to the verdict when there is one", () => {
    const lines = measuredLines(
      summary({ assessment: { ...ASSESSMENT, verdict: "anomalous", note: "retry-heavy" } }),
      { recordedEarlier: true },
    );
    expect(lines).toContain("Was that normal for a task like this? anomalous — retry-heavy");
  });

  it("treats insufficient_data as first-class — no error framing anywhere", () => {
    const text = measuredLines(summary(), { recordedEarlier: true }).join("\n");
    for (const word of [
      "error",
      "sorry",
      "unfortunately",
      "couldn't",
      "could not",
      "failed",
      "unavailable",
      "unknown",
      "n/a",
      "⚠",
    ]) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
    // The exact same shape as any other verdict — one line, one field.
    const normal = measuredLines(
      summary({ assessment: { ...ASSESSMENT, verdict: "normal" } }),
      { recordedEarlier: true },
    );
    expect(normal).toHaveLength(
      measuredLines(summary(), { recordedEarlier: true }).length,
    );
  });

  it("carries no engine vocabulary and no rate", () => {
    const text = measuredLines(summary(), { recordedEarlier: true })
      .join("\n")
      .toLowerCase();
    for (const word of [
      "coverage",
      "stability",
      "bandwidth",
      "csr",
      "neighbor",
      "neighbour",
      "out_of_domain",
      "usually",
      "often",
      "most ",
      "rarely",
    ]) {
      expect(text).not.toContain(word);
    }
  });

  it("prints a positive share that rounds to zero as <1%, never 0%", () => {
    const lines = measuredLines(
      summary({
        phases: { ...PHASES, other: { tokens: 3, share: 0.0001 } },
      }),
      { recordedEarlier: true },
    );
    expect(lines[1]).toContain("other <1%");
    expect(lines[1]).not.toContain("other 0%");
  });

  it("prints an honest zero as 0%", () => {
    const lines = measuredLines(
      summary({ phases: { ...PHASES, other: { tokens: 0, share: 0 } } }),
      { recordedEarlier: true },
    );
    expect(lines[1]).toContain("other 0%");
  });
});

// ---------------------------------------------------------------------------
// CAPTURE — the one shared submit helper, and every path that funnels through it
// ---------------------------------------------------------------------------

function seedPending(estimateId: string, extra: Partial<PendingEntry> = {}) {
  writePending({
    version: 1,
    entries: [
      {
        estimate_id: estimateId,
        query: "refactor the parser",
        project_id: projectIdFromCwd(cwd, home),
        created_at: RECENT,
        attempts: 0,
        ...extra,
      },
    ],
  });
}

describe("submitActuals — capture", () => {
  function pendingStore(): PendingStore {
    return new PendingStore({ path: join(home, ".budgetary", "pending.json") });
  }

  it("captures the 202's summary and returns it to the caller", async () => {
    seedPending("est_cap");
    const s = pendingStore();
    const entry = s.read().entries[0]!;
    const outcome = await submitActuals({
      store: s,
      client: asClient(makeFakeClient()),
      entry,
      counts: { tokensIn: 100, tokensOut: 200, success: true, durationMs: 5 },
      measured: store(),
    });

    expect(outcome.submitted).toBe(true);
    expect(outcome.summary).toEqual({
      estimate_id: "est_cap",
      project_id: projectIdFromCwd(cwd, home),
      phases: PHASES,
      assessment: ASSESSMENT,
    });
    const buffered = store().read();
    expect(buffered).toHaveLength(1);
    expect(buffered[0]!.estimate_id).toBe("est_cap");
    // The project the run belonged to travels with the record, so a later
    // estimate can prefer showing it where it happened.
    expect(buffered[0]!.project_id).toBe(projectIdFromCwd(cwd, home));
  });

  it("captures NOTHING from a 202 without an assessment (older deployment)", async () => {
    seedPending("est_legacy");
    const s = pendingStore();
    const outcome = await submitActuals({
      store: s,
      client: asClient(makeFakeClient(async () => legacyResponse())),
      entry: s.read().entries[0]!,
      counts: { tokensIn: 100, tokensOut: 200, success: true, durationMs: 5 },
      measured: store(),
    });

    // The submit is unaffected — it is the total that is the contract.
    expect(outcome.submitted).toBe(true);
    expect(outcome.summary).toBeUndefined();
    // Fail closed to SILENCE: no buffer file, nothing to render, ever.
    expect(existsSync(measuredFilePath(home))).toBe(false);
    expect(store().claim(projectIdFromCwd(cwd, home))).toBeNull();
  });

  it("captures nothing on a FAILED submit", async () => {
    seedPending("est_fail");
    const s = pendingStore();
    const outcome = await submitActuals({
      store: s,
      client: asClient(
        makeFakeClient(async () => {
          throw new Error("network down");
        }),
      ),
      entry: s.read().entries[0]!,
      counts: { tokensIn: 1, tokensOut: 2, success: true, durationMs: 5 },
      measured: store(),
    });
    expect(outcome.submitted).toBe(false);
    expect(outcome.summary).toBeUndefined();
    expect(existsSync(measuredFilePath(home))).toBe(false);
  });

  it("still submits when no buffer is injected at all", async () => {
    seedPending("est_nobuf");
    const s = pendingStore();
    const fake = makeFakeClient();
    const outcome = await submitActuals({
      store: s,
      client: asClient(fake),
      entry: s.read().entries[0]!,
      counts: { tokensIn: 1, tokensOut: 2, success: true, durationMs: 5 },
    });
    expect(outcome.submitted).toBe(true);
    expect(fake.submitActuals).toHaveBeenCalledTimes(1);
    expect(existsSync(measuredFilePath(home))).toBe(false);
  });

  it("a submit survives a buffer that cannot be written", async () => {
    seedPending("est_ro");
    const s = pendingStore();
    const entry = s.read().entries[0]!;
    chmodSync(join(home, ".budgetary"), 0o500);
    const outcome = await submitActuals({
      store: s,
      client: asClient(makeFakeClient()),
      entry,
      counts: { tokensIn: 1, tokensOut: 2, success: true, durationMs: 5 },
      measured: store(),
    });
    chmodSync(join(home, ".budgetary"), 0o700);
    // The POST won, so the outcome is `submitted` regardless of the buffer.
    expect(outcome.submitted).toBe(true);
    expect(outcome.summary).not.toBeUndefined();
  });
});

describe("every submit path funnels through the one helper", () => {
  it("the session-end hook captures — and stays silent", async () => {
    seedPending("est_hook");
    const errs: string[] = [];
    const code = await runAutoActuals({
      payload: { transcript_path: "/tmp/transcript.jsonl", reason: "clear" },
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      stderr: { write: (s) => errs.push(s) },
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => ({ tokensIn: 12340, tokensOut: 36210, trace: [] }),
    });

    expect(code).toBe(0);
    expect(store().read().map((r) => r.estimate_id)).toEqual(["est_hook"]);
    // A SessionEnd hook's stdout never reaches the user, so it prints nothing —
    // it captures, and the next estimate shows what it captured.
    expect(errs.join("")).toBe("");
  });

  it("the hand-run report-actual captures", async () => {
    seedPending("est_manual");
    const out: string[] = [];
    await runManualActuals({
      env: ENV,
      home,
      cwd,
      out: (l) => out.push(l),
      prompt: scripted(["100", "200", "y", ""]),
      clientFactory: () => asClient(makeFakeClient()),
    });
    expect(store().read().map((r) => r.estimate_id)).toEqual(["est_manual"]);
  });

  it("the hand-run on-session-end --transcript captures", async () => {
    seedPending("est_rollout");
    const out: string[] = [];
    await runRolloutActuals({
      transcriptPath: "/tmp/rollout.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => ({ tokensIn: 10, tokensOut: 20, trace: [] }),
    });
    expect(store().read().map((r) => r.estimate_id)).toEqual(["est_rollout"]);
  });

  it("the in-process 0024e reconcile captures", async () => {
    // The retry branch: the entry already carries its own measured counts from a
    // prior failed submit, so no transcript is read and the submit is immediate.
    const entry: PendingEntry = {
      estimate_id: "est_reconciled",
      query: "q",
      project_id: projectIdFromCwd(cwd, home),
      created_at: RECENT,
      attempts: 1,
      tokens_in: 500,
      tokens_out: 900,
      success: true,
      duration_ms: 1000,
      session_id: "aaaaaaaa-1111-4222-8333-444444444444",
      tool_use_id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA",
      transcript_dir: join(home, ".claude", "projects", "x"),
      owner_pid: 999999,
    };
    writePending({ version: 1, entries: [entry] });

    const outcome = await reconcileEntry({
      entry,
      apiKey: "bg_test_dummy",
      baseUrl: "https://api.example.test",
      home,
      env: ENV,
      now: () => NOW,
      clientFactory: () => asClient(makeFakeClient()),
    });

    expect(outcome).toBe("submitted");
    expect(store().read().map((r) => r.estimate_id)).toEqual(["est_reconciled"]);
  });
});

function scripted(answers: string[]): (q: string) => Promise<string> {
  let i = 0;
  return async () => answers[i++] ?? "";
}

// ---------------------------------------------------------------------------
// RENDER on hand-run CLI stdout — one claim, one source
// ---------------------------------------------------------------------------

describe("CLI stdout — the summary beside the confirmation", () => {
  const BAND = { forecast_p10: 1000, forecast_p50: 4000, forecast_p90: 20000 };

  it("report-actual prints the server's summary and DROPS the local forecast line", async () => {
    seedPending("est_cli", BAND);
    const out: string[] = [];
    const code = await runManualActuals({
      env: ENV,
      home,
      cwd,
      out: (l) => out.push(l),
      prompt: scripted(["4,000", "1,000", "y", ""]),
      clientFactory: () => asClient(makeFakeClient()),
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      "Reporting actuals for this estimate:",
      "  refactor the parser",
      "",
      "Did the run complete its objective?",
      "  1. Yes",
      "  2. No",
      "  3. Not sure / prefer not to say",
      "How did the run end?",
      "  1. It ended on its own (no cap was reached)",
      "  2. A wall-clock watchdog in the calling harness killed it",
      "  3. A cap inside the agent host fired (max turns, context exhaustion, a token budget)",
      "  4. A human or an automation deliberately aborted it",
      "  5. Not sure / prefer not to say",
      "Actuals submitted (est_cli). Thanks — this calibrates future estimates.",
      "  Measured breakdown for est_cli:",
      "  exploration 29% · generation 41% · testing 12% · retries 14% · other 4%",
      "  48,550 tokens measured",
      "  Was that normal for a task like this? insufficient_data",
      "  Composition: retry_heavy (burn share 18%)",
    ]);
    // The client-side band comparison is a SECOND derivation of the claim the
    // server just answered. Where the server answered, it stands down.
    expect(out.join("\n")).not.toContain("Forecast check:");
  });

  it("report-actual keeps the local forecast line when the server returned nothing", async () => {
    seedPending("est_cli_old", BAND);
    const out: string[] = [];
    await runManualActuals({
      env: ENV,
      home,
      cwd,
      out: (l) => out.push(l),
      prompt: scripted(["4,000", "1,000", "y", ""]),
      clientFactory: () => asClient(makeFakeClient(async () => legacyResponse())),
    });

    expect(out.join("\n")).toContain(
      "  Forecast check: actual 5,000 tokens vs forecast ~4,000 (within p10–p90).",
    );
    expect(out.join("\n")).not.toContain("Measured breakdown");
  });

  it("on-session-end --transcript prints the summary and drops the local line", async () => {
    seedPending("est_roll", BAND);
    const out: string[] = [];
    await runRolloutActuals({
      transcriptPath: "/tmp/rollout.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(makeFakeClient()),
      readUsage: () => ({ tokensIn: 4000, tokensOut: 1000, trace: [] }),
    });

    const text = out.join("\n");
    expect(text).toContain("Actuals submitted (est_roll): 4,000 in / 1,000 out");
    expect(text).toContain("  Measured breakdown for est_roll:");
    expect(text).toContain("  Was that normal for a task like this? insufficient_data");
    expect(text).not.toContain("Forecast check:");
  });

  it("on-session-end --transcript keeps the local line against an older deployment", async () => {
    seedPending("est_roll_old", BAND);
    const out: string[] = [];
    await runRolloutActuals({
      transcriptPath: "/tmp/rollout.jsonl",
      success: true,
      env: ENV,
      home,
      cwd,
      now: () => NOW,
      out: (l) => out.push(l),
      clientFactory: () => asClient(makeFakeClient(async () => legacyResponse())),
      readUsage: () => ({ tokensIn: 4000, tokensOut: 1000, trace: [] }),
    });
    expect(out.join("\n")).toContain("Forecast check:");
    expect(out.join("\n")).not.toContain("Measured breakdown");
  });

  it("prints the summary even where there is no local band to compare against", async () => {
    // A void estimate stores no forecast band, so the local line never existed
    // for it — the server's measurement is the only thing this run can be told.
    seedPending("est_noband");
    const out: string[] = [];
    await runManualActuals({
      env: ENV,
      home,
      cwd,
      out: (l) => out.push(l),
      prompt: scripted(["10", "20", "y", ""]),
      clientFactory: () => asClient(makeFakeClient()),
    });
    expect(out.join("\n")).toContain("  Measured breakdown for est_noband:");
  });
});

// ---------------------------------------------------------------------------
// RENDER at the next estimate — ordering, once-per-run, and what is NOT burned
// ---------------------------------------------------------------------------

const VOID_TEXT =
  "No forecast for this task — Budgetary has no firm basis to judge one like it, and won't guess.\n" +
  "This estimate wasn't billed. Proceed on your own judgment — an abstention is an answer, not an error.";

/**
 * Derived from the transcribed literal above, never from `renderEstimate` — so
 * the byte comparisons below still prove the OUTPUT opens with these exact
 * bytes. See the note on `VOID_BYTES` in `format.test.ts`, which owns the one
 * remaining hardcoded length in the suite.
 */
const VOID_BYTES = Buffer.byteLength(VOID_TEXT, "utf8");

function estimateResponse(isVoid: boolean): EstimateResponse {
  return isVoid
    ? {
        estimateId: "est_void",
        scenario: "out_of_domain",
        void: true,
        distribution: null,
        confidence: 0,
        model: "claude-opus-4-7",
        expiresAt: "2026-08-10T10:00:00Z",
      }
    : {
        estimateId: "est_priced",
        scenario: "confident",
        void: false,
        distribution: { p10: 1000, p50: 4000, p90: 20000, unit: "tokens" },
        confidence: 0.7,
        model: "claude-opus-4-7",
        expiresAt: "2026-08-10T10:00:00Z",
      };
}

async function estimate(
  env: NodeJS.ProcessEnv,
  isVoid = false,
): Promise<string> {
  const r = await runEstimateTool({
    query: "add a flag",
    env,
    cwd,
    home,
    now: () => NOW,
    clientFactory: () =>
      asClient(makeFakeClient(undefined, async () => estimateResponse(isVoid))),
  });
  return r.text;
}

/** The buffered summary belonging to THIS project, as the submit paths write it. */
function bufferForThisProject(estimateId = "est_earlier") {
  store().record(
    summary({ estimate_id: estimateId, project_id: projectIdFromCwd(cwd, home) }),
  );
}

const MEASURED_BLOCK = [
  "Measured breakdown for est_earlier (a run recorded earlier):",
  "exploration 29% · generation 41% · testing 12% · retries 14% · other 4%",
  "48,550 tokens measured",
  "Was that normal for a task like this? insufficient_data",
  "Composition: retry_heavy (burn share 18%)",
].join("\n");

describe("the next estimate renders the measurement", () => {
  const CC = {
    BUDGETARY_API_KEY: "bg_test_x",
    BUDGETARY_HOST: "claude-code",
    // Declared hook: suppresses the one-time notice, so these cases isolate the
    // measured block. The combined case below turns it back on deliberately.
    BUDGETARY_SESSION_END: "hook",
  } as NodeJS.ProcessEnv;

  it("appends it beneath a PRICED estimate", async () => {
    bufferForThisProject();
    const text = await estimate(CC);
    expect(text).toContain("Estimated cost: ~4,000 tokens");
    expect(text.endsWith(`\n\n${MEASURED_BLOCK}`)).toBe(true);
  });

  it("appends it beneath a VOID estimate, after everything the void says", async () => {
    bufferForThisProject();
    const text = await estimate(CC, true);
    expect(text).toBe(
      [
        VOID_TEXT,
        "",
        "Estimate id: est_void",
        "",
        "Pending estimate stored. With the Budgetary plugin installed, actuals are",
        "recorded automatically at session end — otherwise run `npx @budgetary/mcp report-actual`.",
        "When this run's token counts are recorded, its measured breakdown appears here.",
        "",
        MEASURED_BLOCK,
      ].join("\n"),
    );
    // The void's own message opens the render, byte for byte.
    expect(
      Buffer.from(text, "utf8").subarray(0, VOID_BYTES).toString("utf8"),
    ).toBe(VOID_TEXT);
  });

  it("shows it ONCE — the next estimate says nothing more about it", async () => {
    bufferForThisProject();
    const first = await estimate(CC);
    expect(first).toContain("Measured breakdown for est_earlier");
    const second = await estimate(CC);
    expect(second).not.toContain("Measured breakdown");
    const third = await estimate(CC, true);
    expect(third).not.toContain("Measured breakdown");
  });

  it("burns no marker on a run that showed nothing", async () => {
    // Nothing buffered: the estimate renders exactly what it always did, and the
    // buffer file is not even created.
    const text = await estimate(CC);
    expect(text).not.toContain("Measured breakdown");
    expect(existsSync(measuredFilePath(home))).toBe(false);

    // Now capture one, and it is still available to be shown.
    bufferForThisProject();
    expect(await estimate(CC)).toContain("Measured breakdown for est_earlier");
  });

  it("shows one summary per estimate, oldest last — never a backlog dump", async () => {
    store().record(summary({ estimate_id: "est_a", project_id: projectIdFromCwd(cwd, home) }));
    store().record(summary({ estimate_id: "est_b", project_id: projectIdFromCwd(cwd, home) }));
    const first = await estimate(CC);
    expect(first).toContain("est_b");
    expect(first).not.toContain("est_a");
    const second = await estimate(CC);
    expect(second).toContain("est_a");
  });

  it("prefers this project's summary, and says so when it shows another's", async () => {
    store().record(summary({ estimate_id: "est_other", project_id: "another-project" }));
    store().record(summary({ estimate_id: "est_here", project_id: projectIdFromCwd(cwd, home) }));

    const own = await estimate(CC);
    expect(own).toContain("Measured breakdown for est_here (a run recorded earlier):");

    const foreign = await estimate(CC);
    expect(foreign).toContain(
      "Measured breakdown for est_other (a run recorded earlier in a different project directory):",
    );
  });

  it("renders nothing when the estimate itself failed", async () => {
    // No key: the tool returns guidance and never reaches the render seam, so
    // the buffered summary is still there for the next real estimate.
    bufferForThisProject();
    const r = await runEstimateTool({
      query: "add a flag",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      now: () => NOW,
      clientFactory: () => asClient(makeFakeClient()),
    });
    expect(r.text).not.toContain("Measured breakdown");
    expect(await estimate(CC)).toContain("Measured breakdown for est_earlier");
  });
});

// ---------------------------------------------------------------------------
// ★ The ordering claim, settled by rendering the whole thing
// ---------------------------------------------------------------------------

describe("combined output — the hook-less notice stays visually last", () => {
  const HOOKLESS_CC = {
    BUDGETARY_API_KEY: "bg_test_x",
    BUDGETARY_HOST: "claude-code",
  } as NodeJS.ProcessEnv;

  it("void + footer + measured summary + notice, in exactly that order", async () => {
    bufferForThisProject();
    const text = await estimate(HOOKLESS_CC, true);

    // Whole-output equality — the claim is settled by rendering it, not by
    // reasoning about it. Three blocks, each separated by one blank line.
    expect(text).toBe(
      [
        VOID_TEXT,
        "",
        "Estimate id: est_void",
        "",
        "Pending estimate stored. With the Budgetary plugin installed, actuals are",
        "recorded automatically at session end — otherwise run `npx @budgetary/mcp report-actual`.",
        "When this run's token counts are recorded, its measured breakdown appears here.",
        "",
        MEASURED_BLOCK,
        "",
        ...hooklessNoticeLines(),
      ].join("\n"),
    );

    // Stated again as positions, so a failure says WHICH block moved.
    const voidAt = text.indexOf(VOID_TEXT);
    const idAt = text.indexOf("Estimate id: est_void");
    const footerAt = text.indexOf("Pending estimate stored.");
    const promiseAt = text.indexOf("When this run's token counts are recorded");
    const measuredAt = text.indexOf("Measured breakdown for est_earlier");
    const noticeAt = text.indexOf("\n─────\n");
    expect(voidAt).toBe(0);
    expect(idAt).toBeGreaterThan(voidAt);
    expect(footerAt).toBeGreaterThan(idAt);
    expect(promiseAt).toBeGreaterThan(footerAt);
    expect(measuredAt).toBeGreaterThan(promiseAt);
    expect(noticeAt).toBeGreaterThan(measuredAt);
    expect(text.endsWith(hooklessNoticeLines().join("\n"))).toBe(true);

    // The void's own message opens the render with all three blocks present,
    // and the seam beneath it is still a blank line.
    expect(Buffer.from(text, "utf8").subarray(0, VOID_BYTES).toString("utf8")).toBe(
      VOID_TEXT,
    );
    expect(
      Buffer.from(text, "utf8").subarray(VOID_BYTES, VOID_BYTES + 2).toString("utf8"),
    ).toBe("\n\n");
  });

  it("priced + measured summary + notice, in exactly that order", async () => {
    bufferForThisProject();
    const text = await estimate(HOOKLESS_CC);
    const measuredAt = text.indexOf("Measured breakdown for est_earlier");
    const footerAt = text.indexOf("Pending estimate stored.");
    const noticeAt = text.indexOf("\n─────\n");
    expect(footerAt).toBeGreaterThan(-1);
    expect(measuredAt).toBeGreaterThan(footerAt);
    expect(noticeAt).toBeGreaterThan(measuredAt);
    expect(text.endsWith(hooklessNoticeLines().join("\n"))).toBe(true);
    // One blank line between the blocks — never a run-on, never a double gap.
    expect(text).toContain(
      "Composition: retry_heavy (burn share 18%)\n\n─────\nNote for the person running this session.",
    );
  });

  it("the notice still fires on its own when nothing was measured", async () => {
    const text = await estimate(HOOKLESS_CC, true);
    expect(text).not.toContain("Measured breakdown");
    expect(text.endsWith(hooklessNoticeLines().join("\n"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tool description's FINAL clause — the only part of it this item owns
// ---------------------------------------------------------------------------

describe("the estimate tool's description", () => {
  const description = TOOLS[0]!.description!;

  it("leads with the measurement as the CONSEQUENCE of recording (0026b-2)", () => {
    // ★ This assertion used to read "leaves the lead sentence exactly as it
    // was", and it existed to prove 0026c did not touch copy it did not own.
    // 0026b-2 owns that copy, so the assertion is REWRITTEN rather than deleted
    // — deleting it would leave the lead unpinned, which is the one outcome
    // neither item wants. Transcribed, not imported, for the same reason as
    // before: an expectation read off the same string passes whatever it
    // becomes.
    expect(
      description.startsWith(
        "Return a pre-flight, probabilistic token-spend estimate for a coding " +
          "task before you run it, and store it so the same run's realized spend " +
          "can be measured afterward — the forecast is a probability; the " +
          "measurement is a count.",
      ),
    ).toBe(true);
    // The measurement is named as what RECORDING yields, never as something
    // this call serves. A description that advertised "see where your tokens
    // went" would bait a call the tool cannot answer — the breakdown is
    // captured at submit and rendered beneath a LATER estimate.
    expect(description).not.toMatch(/\b(see|show|view|get)\b[^.]{0,40}\btokens went\b/i);
    expect(description).not.toContain("realized cost can be recorded");
  });

  it("names the abstention as a returned outcome, per query and never as a rate", () => {
    // ★ The highest-value edit in 0026b-2. S3 used to promise a range
    // unconditionally, so a model told it would get a number treats an
    // abstention as a failure — and is then under pressure to re-ask with a
    // rephrased query, which bills a second estimate.
    expect(description).toContain(
      "or no range at all when there is no firm basis to forecast this particular task",
    );
    expect(description).toContain("an honest answer, not an error");
    // ⚠ Per QUERY. The moment this acquires a frequency word it becomes a claim
    // about how much is covered, which no public surface here may make.
    for (const word of [
      "usually",
      "often",
      "most ",
      "rarely",
      "typically",
      "seldom",
      "sometimes",
      "generally",
      "%",
      "percent",
    ]) {
      expect(description.toLowerCase()).not.toContain(word);
    }
    expect(description).not.toMatch(/\b\d+\s*(%|percent)/);
  });

  it("makes no corpus, timeline, accuracy or commercial claim — over the WHOLE string", () => {
    // Asserted by a test over the entire description rather than by a
    // reviewer's eye, because every one of these is a claim the product cannot
    // support and none of them is visible from a diff of one sentence.
    const d = description.toLowerCase();
    // No corpus or coverage description, and no engine vocabulary.
    for (const word of [
      "corpus",
      "coverage",
      "covered",
      "dataset",
      "training",
      "stability",
      "bandwidth",
      "csr",
      "neighbor",
      "out_of_domain",
      "out of domain",
    ]) {
      expect(d).not.toContain(word);
    }
    // No accuracy, benchmark or calibration claim. "the measurement is a count"
    // is arithmetic over recorded numbers — a statement about what the number
    // IS, not about how well anything predicts — which is why it is sayable.
    for (const word of [
      "accurate",
      "accuracy",
      "precise",
      "benchmark",
      "calibrat",
      "proven",
      "guarantee",
      "reliable",
      "state of the art",
    ]) {
      expect(d).not.toContain(word);
    }
    // No timeline: nothing here knows when, or whether, counts are submitted.
    for (const word of ["soon", "shortly", "within", "minute", "hour", "days", "immediately"]) {
      expect(d).not.toContain(word);
    }
    // No commercial statement of any kind.
    for (const word of [
      "price",
      "pricing",
      "free",
      "paid",
      "subscription",
      "plan",
      "tier",
      "licence",
      "license",
      "enterprise",
      "trial",
      "$",
    ]) {
      expect(d).not.toContain(word);
    }
  });

  it("drops the clause that this change makes false", () => {
    expect(description).not.toContain(
      "it never reports how many tokens a run actually used",
    );
  });

  it("keeps the live-usage disclaimer and makes the post-hoc claim conditional", () => {
    expect(description).toContain("it does not observe the current run's usage");
    expect(description).toContain(
      "when an earlier run's counts have been recorded, it reports that run's measured breakdown",
    );
  });

  it("adds no tool — the surface is still exactly `estimate`", () => {
    expect(TOOLS).toHaveLength(1);
    expect(TOOLS[0]!.name).toBe("estimate");
  });
});
