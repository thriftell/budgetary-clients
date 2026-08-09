import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActualsResponse,
  Assessment,
  EstimateResponse,
  LedgerPage,
  Phases,
} from "@budgetary/sdk";
import { BudgetaryAuthError } from "@budgetary/sdk";

import { measuredFilePath } from "../src/config.js";
import {
  claimOneTimeNotice,
  DATA_DISCLOSURE_BODY,
  DATA_NOTICE,
  dataDisclosureLines,
  hooklessNoticeLines,
  noticeMarkerPath,
  SESSION_END_ENV,
  SESSION_END_HOOK,
} from "../src/contribution.js";
import { runDoctor } from "../src/doctor.js";
import { MeasuredStore, type MeasuredSummary } from "../src/measured.js";
import { projectIdFromCwd, runEstimateTool } from "../src/tools/estimate.js";
import { redactBashTarget, redactFileTarget } from "../src/transcript.js";

// ---------------------------------------------------------------------------
// 0026b-2 — the first-run data disclosure.
//
// This file owns the block on a GENUINELY FRESH home. `contribution.test.ts` and
// `measured.test.ts` spend the marker in their own `beforeEach` so their
// whole-output goldens keep pinning their own subjects (see the notes there);
// everything those files stop covering is covered here, including the worst-case
// golden that stacks this block with all of theirs.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-09T10:14:00Z");

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

/** The void's own message, TRANSCRIBED — never read off `renderEstimate`. */
const VOID_TEXT =
  "No forecast for this task — Budgetary has no firm basis to judge one like it, and won't guess.\n" +
  "This estimate wasn't billed. Proceed on your own judgment — an abstention is an answer, not an error.";

/** The measured block, transcribed from the shipped copy for the same reason. */
const MEASURED_BLOCK = [
  "Measured breakdown for est_earlier (a run recorded earlier):",
  "exploration 29% · generation 41% · testing 12% · retries 14% · other 4%",
  "48,550 tokens measured",
  "Was that normal for a task like this? insufficient_data",
  "Composition: retry_heavy (burn share 18%)",
].join("\n");

const CC_FOOTER = [
  "Pending estimate stored. With the Budgetary plugin installed, actuals are",
  "recorded automatically at session end — otherwise run `npx @budgetary/mcp report-actual`.",
];

const MEASURED_FOLLOW_UP =
  "When this run's token counts are recorded, its measured breakdown appears here.";

let home: string;
let cwd: string;

beforeEach(() => {
  // ★ NOT pre-claimed. Every test in this file starts from a genuinely
  // never-seen install, which is the whole subject here.
  home = mkdtempSync(join(tmpdir(), "budgetary-disclosure-"));
  cwd = mkdtempSync(join(tmpdir(), "budgetary-disclosure-cwd-"));
  mkdirSync(join(home, ".budgetary"), { recursive: true });
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

function voidResponse(): EstimateResponse {
  return {
    estimateId: "est_void",
    scenario: "out_of_domain",
    void: true,
    distribution: null,
    confidence: 0,
    model: "claude-opus-4-7",
    expiresAt: "2026-08-10T10:00:00Z",
  };
}

function pricedResponse(): EstimateResponse {
  return {
    estimateId: "est_priced",
    scenario: "confident",
    void: false,
    distribution: { p10: 1000, p50: 4000, p90: 20000, unit: "tokens" },
    confidence: 0.7,
    model: "claude-opus-4-7",
    expiresAt: "2026-08-10T10:00:00Z",
  };
}

const asClient = (fake: unknown) =>
  fake as unknown as import("@budgetary/sdk").BudgetaryClient;

function fakeClient(estimateImpl: () => Promise<EstimateResponse>) {
  return asClient({
    estimate: vi.fn(estimateImpl),
    submitActuals: vi.fn(
      async (): Promise<ActualsResponse> => ({ received: true, ledgerEntryId: "led_x" }),
    ),
    getLedger: vi.fn(async (): Promise<LedgerPage> => ({ entries: [], nextCursor: null })),
  });
}

async function estimate(
  env: NodeJS.ProcessEnv,
  isVoid = false,
): Promise<{ text: string; isError: boolean }> {
  const r = await runEstimateTool({
    query: "add a flag",
    env,
    cwd,
    home,
    now: () => NOW,
    clientFactory: () =>
      fakeClient(async () => (isVoid ? voidResponse() : pricedResponse())),
  });
  return { text: r.text, isError: r.isError };
}

/** Buffer a measured summary for THIS project, as an earlier submit would have. */
function bufferMeasured(): void {
  const summary: MeasuredSummary = {
    estimate_id: "est_earlier",
    project_id: projectIdFromCwd(cwd, home),
    phases: PHASES,
    assessment: ASSESSMENT,
  };
  new MeasuredStore({ path: measuredFilePath(home), now: () => NOW }).record(summary);
}

/** A key, no host: the plainest install there is. */
const KEY_ONLY = { BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv;
/** Hook-less Claude Code — the only env where the `─────` notice also fires. */
const HOOKLESS_CC = {
  BUDGETARY_API_KEY: "bg_test_x",
  BUDGETARY_HOST: "claude-code",
} as NodeJS.ProcessEnv;

/**
 * The disclosure block, TRANSCRIBED — never read off `dataDisclosureLines()`,
 * which is the code under test.
 *
 * ★ This was originally `dataDisclosureLines().join("\n")`, and that was wrong in
 * exactly the way this suite warns about everywhere else: an expectation derived
 * from the code under test passes whatever that code becomes. It was proven, not
 * argued — rewriting one body line to "Generally we can judge a task, but seldom
 * out-of-domain ones…" left the whole suite green, on the only genuinely new
 * public string this change ships, in the block appended to every user's first
 * estimate AND in `doctor`'s output on every run. Held here, every golden below
 * fails loudly on a copy change. Same discipline as `VOID_TEXT` above.
 */
const DISCLOSURE =
  "One-time note for the person running this session — the first thing this package can show\n" +
  "you, and so one estimate late: the call you just made has already gone out.\n" +
  "`estimate` sends the task text you pass it to api.budgetary.tools. Recording a finished\n" +
  "run sends that run's token counts, its duration, and — on Claude Code — a redacted step\n" +
  "trace: per step, the tool's name and a digested descriptor of what it acted on. Never\n" +
  "file contents, never a path, and of a command only allowlisted words like `go test`.\n" +
  "That is not the whole list. A fuller account of what this package sends lives here:\n" +
  "https://github.com/thriftell/budgetary-clients/blob/main/clients/mcp/README.md#privacy";

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

describe("the first-run disclosure — what it says", () => {
  it("★ is EXACTLY the transcribed copy — the pin every golden below rests on", () => {
    // Whole-string equality against the transcription, so a copy change fails
    // here first and by name, rather than silently redefining every expectation
    // in this file. This is the assertion whose absence let a rule-violating
    // rewrite of the body pass 586 green tests.
    expect(dataDisclosureLines().join("\n")).toBe(DISCLOSURE);
    // And the shared body really is the tail of it — two lead lines, then the
    // six lines `doctor` also prints.
    expect(dataDisclosureLines()).toHaveLength(8);
    expect(dataDisclosureLines().slice(2).join("\n")).toBe(
      [...DATA_DISCLOSURE_BODY].join("\n"),
    );
  });

  it("names both transmissions, and the lag that makes it one call late", () => {
    // The obvious brief — "disclose data collection on submit" — is a PARTIAL
    // disclosure: by the time any runtime line can render, `estimate` has
    // already sent the task text. Both halves are named, and so is the lag.
    expect(DISCLOSURE).toContain("`estimate` sends the task text you pass it");
    expect(DISCLOSURE).toContain("Recording a finished");
    expect(DISCLOSURE).toContain("one estimate late");
    expect(DISCLOSURE).toContain("has already gone out");
  });

  it("is addressed to the HUMAN in its first words", () => {
    // This text lands in the model's context too. Naming the reader keeps it
    // legible as a status note rather than an instruction to the assistant.
    expect(DISCLOSURE.startsWith("One-time note for the person running this session")).toBe(
      true,
    );
  });

  it("⚠ is a disclosure, NOT consent — it asks for nothing and gates nothing", () => {
    const d = DISCLOSURE.toLowerCase();
    for (const word of [
      "by continuing",
      "you agree",
      "consent",
      "accept",
      "acknowledge",
      "opt in",
      "opt-in",
      "opt out",
      "opt-out",
      "terms of service",
      "terms and conditions",
      "privacy policy",
      "press",
      "type y",
      "confirm",
    ]) {
      expect(d).not.toContain(word);
    }
    // No question is asked of anyone.
    expect(DISCLOSURE).not.toContain("?");
  });

  it("⚠ claims NO completeness of its own — neither for itself nor for the README", () => {
    // The estimate also carries a salted project id, a host tag, an optional
    // language tag, an optional model identifier and a per-call request id. A
    // block claiming to be the whole list would simply be false, so it
    // disclaims and points instead.
    expect(DISCLOSURE).toContain("That is not the whole list.");
    const d = DISCLOSURE.toLowerCase();
    expect(d).not.toContain("nothing else leaves");
    expect(d).not.toContain("nothing else is");
    expect(d).not.toContain("only these");
    expect(d).not.toContain("and that is all");
    // ★ And it does not promise the LINKED section is exhaustive either. The
    // earlier wording ("Every field that leaves this machine, named one by one")
    // did, and it was wrong — that section omitted the host tag, the model
    // identifier, the per-call request id and the declared run ending. Those are
    // added there in this same change, but the softer promise is what keeps this
    // line true the next time the list falls behind the code.
    expect(DISCLOSURE).toContain("A fuller account of what this package sends lives here");
    expect(DISCLOSURE).not.toContain("Every field that leaves this machine");
    expect(d).not.toContain("named one by one");
    expect(d).not.toContain("complete field");
  });

  it("★ points at the versioned README, never at a terms page, and invents no URL", () => {
    // The README is versioned with the code that does the sending, so it is the
    // accurate account. Pointing a runtime disclosure at terms of service would
    // read as an acceptance gesture. There is no /privacy page on the site.
    expect(DISCLOSURE).toContain(
      "https://github.com/thriftell/budgetary-clients/blob/main/clients/mcp/README.md#privacy",
    );
    expect(DISCLOSURE).not.toContain("budgetary.tools/privacy");
    expect(DISCLOSURE).not.toContain("/terms");
    // Exactly one URL, so there is one thing to keep alive.
    expect(DISCLOSURE.match(/https?:\/\/\S+/g)).toHaveLength(1);
  });

  it("⚠ makes the NARROW negative claim, because every wider one is false", () => {
    // ★ A step's descriptor keeps an allowlisted program and build/test keyword
    // in the clear and digests everything after, so "never command arguments"
    // is untrue — and so is "never a whole command", because a bare `pytest` or
    // `npm test` is ENTIRELY allowlisted words and reaches the server as
    // written. Both of those wordings were tried here and both were wrong. What
    // the redaction guarantees is: no file contents, no path, and nothing of a
    // command in the clear but allowlisted words.
    expect(DISCLOSURE).toContain(
      "Never\nfile contents, never a path, and of a command only allowlisted words like `go test`.",
    );
    for (const overclaim of [
      "never file contents, paths, or command arguments",
      "no command arguments",
      "never a whole path or command",
      "never a whole command",
      "nothing of your command",
    ]) {
      expect(DISCLOSURE).not.toContain(overclaim);
    }
  });

  it("⚠ and that narrow claim survives the commands the trace actually sees", () => {
    // The claim is checked against the shipped redaction, not against a reading
    // of it. For each command, whatever reaches the clear must be nothing but
    // allowlisted words — which is exactly what the copy now says, and exactly
    // what "never a whole command" got wrong: for `pytest` and `npm test` the
    // clear text IS the whole command.
    const salt = Buffer.alloc(16, 7);
    for (const cmd of ["pytest", "npm test", "go test", "npx jest --ci", "python -m pytest -q"]) {
      const target = redactBashTarget(cmd, salt);
      expect(target).not.toBeNull();
      // Everything after the allowlisted head is a 12-hex digest, never text.
      expect(target).toMatch(/^[A-Za-z0-9_.:@+-]+( [A-Za-z0-9_.:@+-]+)? [0-9a-f]{12}$/);
      expect(target).not.toContain("--ci");
      expect(target).not.toContain("-q");
    }
    // A path never survives, even as argv[0].
    expect(redactBashTarget("/usr/local/bin/pytest -q", salt)).not.toContain("/usr/local/bin");
    expect(redactFileTarget("/Users/someone/secret/plan.md", salt)).toMatch(/^[0-9a-f]{12}$/);
    // A non-allowlisted program is a bare digest — no cleartext at all.
    expect(redactBashTarget("./scripts/deploy-prod.sh --force", salt)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("makes no rate, corpus, accuracy, timeline or commercial claim", () => {
    // ★ These lists were a strict SUBSET of the ones this same change wrote for
    // the void render and the tool description, and the title named a timeline
    // gate that did not exist. That is how `(out of domain)` escaped in the
    // first place — a sweep narrower than the rule it enforces — so reproducing
    // the gap one file over, on the newest surface, would have been the same
    // mistake twice. They now match their siblings, word for word.
    const d = DISCLOSURE.toLowerCase();
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
      expect(d).not.toContain(word);
    }
    // Both spellings — the spaced one is exactly how the engine label escaped.
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
      "out-of-domain",
    ]) {
      expect(d).not.toContain(word);
    }
    for (const word of [
      "accurate",
      "accuracy",
      "precise",
      "benchmark",
      "calibrat",
      "proven",
      "guarantee",
      "reliable",
    ]) {
      expect(d).not.toContain(word);
    }
    // No timeline — the gate the title named and the file did not have.
    for (const word of ["soon", "shortly", "within", "minute", "hour", "days", "immediately"]) {
      expect(d).not.toContain(word);
    }
    for (const word of [
      "price",
      "pricing",
      "free",
      "paid",
      "subscription",
      "plan",
      "tier",
      "licen",
      "enterprise",
      "trial",
      "$",
    ]) {
      expect(d).not.toContain(word);
    }
  });

  it("carries NO separator of its own — the ───── belongs to the notice", () => {
    expect(DISCLOSURE).not.toContain("─────");
  });

  it("★ doctor and the appended block share ONE source, so they cannot drift", () => {
    // Both compose from DATA_DISCLOSURE_BODY. Only the lead differs, because
    // only one of them is the disclosure MOMENT.
    for (const line of DATA_DISCLOSURE_BODY) expect(DISCLOSURE).toContain(line);
    expect(dataDisclosureLines().slice(2)).toEqual([...DATA_DISCLOSURE_BODY]);
  });
});

// ---------------------------------------------------------------------------
// When it fires
// ---------------------------------------------------------------------------

describe("the first-run disclosure — when it fires", () => {
  it("fires on the FIRST successful estimate, then never again", async () => {
    const first = await estimate(KEY_ONLY);
    expect(first.text.endsWith(`\n\n${DISCLOSURE}`)).toBe(true);
    const second = await estimate(KEY_ONLY);
    expect(second.text).not.toContain("One-time note");
    const third = await estimate(KEY_ONLY, true);
    expect(third.text).not.toContain("One-time note");
  });

  it("⚠ is UNCONDITIONAL on success — every host, priced and void alike", async () => {
    // Not gated on host, not on whether a session-end hook is wired, not on
    // void-vs-priced. Every install can record by hand, and every install
    // reaching this line has already sent a query.
    //
    // `home` must keep being REASSIGNED — the `estimate()` helper closes over
    // the module-level binding — so each iteration reclaims its own directory
    // and the `finally` hands the outer one back to `afterEach`. Without that,
    // this one test orphaned ten temp dirs in tmpdir on every suite run.
    const outer = home;
    try {
      for (const host of [undefined, "claude-code", "codex", "cursor", "copilot"]) {
        for (const isVoid of [false, true]) {
          home = mkdtempSync(join(tmpdir(), "budgetary-disclosure-"));
          mkdirSync(join(home, ".budgetary"), { recursive: true });
          const env = { BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv;
          if (host !== undefined) env.BUDGETARY_HOST = host;
          // Wired HERE; the unwired half of the claim is every other test in
          // this file, none of which sets this variable.
          env[SESSION_END_ENV] = SESSION_END_HOOK;
          const r = await estimate(env, isVoid);
          expect(r.text).toContain("One-time note for the person running this session");
          rmSync(home, { recursive: true, force: true });
        }
      }
    } finally {
      home = outer;
    }
  });

  it("⚠ NEVER on an error path — a failed first estimate does not burn it", async () => {
    // The one expensive mistake: a user whose first estimate fails auth spends
    // the single disclosure they will ever be shown and never sees it.
    const r = await runEstimateTool({
      query: "add a flag",
      env: KEY_ONLY,
      cwd,
      home,
      now: () => NOW,
      clientFactory: () =>
        fakeClient(async () => {
          throw new BudgetaryAuthError({
            code: "authentication_failed",
            message: "bad key",
            httpStatus: 401,
            requestId: "req_401",
          });
        }),
    });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("One-time note");
    expect(existsSync(noticeMarkerPath(DATA_NOTICE, home))).toBe(false);

    // …and it is still there for the next estimate that actually works.
    const ok = await estimate(KEY_ONLY);
    expect(ok.text).toContain("One-time note");
  });

  it("⚠ NEVER on the no-key guidance path either", async () => {
    // That return is `isError: false` but renders no estimate and sends nothing,
    // so there is nothing to disclose and no marker to spend.
    const r = await runEstimateTool({
      query: "add a flag",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      now: () => NOW,
      clientFactory: () => fakeClient(async () => pricedResponse()),
    });
    expect(r.text).not.toContain("One-time note");
    expect(existsSync(noticeMarkerPath(DATA_NOTICE, home))).toBe(false);
  });

  it("⚠ NEVER on an empty query — rejected before anything leaves", async () => {
    const r = await runEstimateTool({
      query: "   ",
      env: KEY_ONLY,
      cwd,
      home,
      now: () => NOW,
      clientFactory: () => fakeClient(async () => pricedResponse()),
    });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("One-time note");
    expect(existsSync(noticeMarkerPath(DATA_NOTICE, home))).toBe(false);
  });

  it("⚠ fails closed to SILENCE when the marker cannot be written", async () => {
    // A claim that cannot reach disk returns false and nothing renders. That is
    // the right failure — the alternative is a per-estimate nag that cannot be
    // dismissed — and it is the whole argument for stating this unconditionally
    // in `doctor`, which the next test covers.
    //
    // ⚠ The obvious simulation does NOT work here, and the reason is worth
    // recording: `chmod 0500 ~/.budgetary` is what `contribution.test.ts` uses
    // to prove `claimOneTimeNotice` returns false, and it does — but only when
    // called directly. Inside an estimate, `PendingStore.ensureDir()` runs
    // FIRST and `chmodSync(dir, 0o700)`s the directory back (it holds the API
    // key, so an already-loose directory is tightened best-effort on every
    // write). The permission is repaired before the claim is attempted, so the
    // notice would render and this test would be asserting nothing.
    //
    // So the failure is staged where `ensureDir` cannot undo it: the marker path
    // itself is occupied. That is a real state — a stale directory, or the
    // planted symlink the `wx` flag exists to refuse — and it fails the write
    // without disturbing anything else the estimate does.
    mkdirSync(noticeMarkerPath(DATA_NOTICE, home), { recursive: true });
    const r = await estimate(KEY_ONLY);
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("One-time note");
    // Everything else is unharmed: silence, never an error, and never a
    // half-rendered estimate.
    expect(r.text).toContain("Estimated cost:");
    expect(r.text).toContain("Pending estimate stored.");
    // And it stays silent — a failed claim must not become a per-estimate nag.
    const again = await estimate(KEY_ONLY);
    expect(again.text).not.toContain("One-time note");
  });

  it("★ and `doctor` still states it in that case — every run, unconditionally", async () => {
    const lines: string[] = [];
    await runDoctor({
      env: {} as NodeJS.ProcessEnv, // no key: the earliest early-return branch
      home,
      out: (l) => lines.push(l),
      now: () => NOW,
    });
    const text = lines.join("\n");
    for (const line of DATA_DISCLOSURE_BODY) expect(text).toContain(line);
    // Stated every time, so it is not a "one-time note" here.
    expect(text).not.toContain("One-time note");
    expect(text).not.toContain("one estimate late");
    // Repeats on the next run, unlike the appended block.
    const again: string[] = [];
    await runDoctor({
      env: {} as NodeJS.ProcessEnv,
      home,
      out: (l) => again.push(l),
      now: () => NOW,
    });
    for (const line of DATA_DISCLOSURE_BODY) expect(again.join("\n")).toContain(line);
  });

  it("uses a marker name that is a MODULE CONSTANT, not host-derived", async () => {
    // Keying it on anything variable re-shows the notice when that thing
    // changes. Seen under one host, silent under another.
    const first = await estimate({ ...KEY_ONLY, BUDGETARY_HOST: "cursor" });
    expect(first.text).toContain("One-time note");
    const second = await estimate({ ...KEY_ONLY, BUDGETARY_HOST: "claude-code" });
    expect(second.text).not.toContain("One-time note");
    expect(existsSync(noticeMarkerPath(DATA_NOTICE, home))).toBe(true);
  });

  it("is independent of the hook-less notice's marker", async () => {
    // Two distinct once-only things. Spending one must not spend the other.
    claimOneTimeNotice(DATA_NOTICE, home);
    const r = await estimate(HOOKLESS_CC);
    expect(r.text).not.toContain("One-time note for the person running this session —");
    expect(r.text).toContain("Note for the person running this session.");
  });
});

// ---------------------------------------------------------------------------
// ★ Ordering — and the worst case, settled by rendering it
// ---------------------------------------------------------------------------

describe("the first-run disclosure — ordering", () => {
  it("sits AFTER the measured block and BEFORE the ───── notice", async () => {
    // The disclosure says what recording sends; the notice instructs the user to
    // wire recording. Instructing before disclosing is the wrong order.
    bufferMeasured();
    const { text } = await estimate(HOOKLESS_CC, true);
    const measuredAt = text.indexOf("Measured breakdown for est_earlier");
    const disclosureAt = text.indexOf("One-time note for the person running this session");
    const noticeAt = text.indexOf("\n─────\n");
    for (const at of [measuredAt, disclosureAt, noticeAt]) expect(at).toBeGreaterThan(-1);
    expect(disclosureAt).toBeGreaterThan(measuredAt);
    expect(noticeAt).toBeGreaterThan(disclosureAt);
    // The notice still closes the message — nothing after it.
    expect(text.endsWith(hooklessNoticeLines().join("\n"))).toBe(true);
  });

  it("★ THE WORST CASE, as one whole string: void + footer + measured + disclosure + notice", async () => {
    // ★ Whole-output equality. The claim is settled by rendering it, not by
    // reasoning about it — five blocks, each separated by exactly one blank
    // line, in the one arrangement that stacks everything this package can say
    // at once. (A GENUINE first run cannot have a buffered measured record, so
    // the real worst case is four blocks; this is the stricter, five-block
    // arrangement an existing user reaches on their next estimate.)
    bufferMeasured();
    const { text } = await estimate(HOOKLESS_CC, true);
    expect(text).toBe(
      [
        VOID_TEXT,
        "",
        "Estimate id: est_void",
        "",
        ...CC_FOOTER,
        MEASURED_FOLLOW_UP,
        "",
        MEASURED_BLOCK,
        "",
        DISCLOSURE,
        "",
        ...hooklessNoticeLines(),
      ].join("\n"),
    );
    // The void's own message still opens it, byte for byte, with everything
    // present — and the blank-line seam beneath it has not moved.
    const bytes = Buffer.from(text, "utf8");
    const voidBytes = Buffer.byteLength(VOID_TEXT, "utf8");
    expect(bytes.subarray(0, voidBytes).toString("utf8")).toBe(VOID_TEXT);
    expect(bytes.subarray(voidBytes, voidBytes + 2).toString("utf8")).toBe("\n\n");
  });

  it("★ THE GENUINE FIRST RUN, as one whole string: four blocks, no measured record", async () => {
    // What a real new install actually sees: nothing has been submitted yet, so
    // there is no measured record to render and the disclosure follows the
    // void's own footer directly.
    const { text } = await estimate(HOOKLESS_CC, true);
    expect(text).toBe(
      [
        VOID_TEXT,
        "",
        "Estimate id: est_void",
        "",
        ...CC_FOOTER,
        MEASURED_FOLLOW_UP,
        "",
        DISCLOSURE,
        "",
        ...hooklessNoticeLines(),
      ].join("\n"),
    );
  });

  it("and on a PRICED first estimate, in the same place", async () => {
    bufferMeasured();
    const { text } = await estimate(HOOKLESS_CC);
    expect(text).toBe(
      [
        text.slice(0, text.indexOf("\n\nMeasured breakdown")),
        "",
        MEASURED_BLOCK,
        "",
        DISCLOSURE,
        "",
        ...hooklessNoticeLines(),
      ].join("\n"),
    );
    // One blank line between the measured block and the disclosure — never a
    // run-on, never a double gap.
    expect(text).toContain(
      "Composition: retry_heavy (burn share 18%)\n\nOne-time note for the person",
    );
    // …and one between the disclosure and the notice.
    expect(text).toContain(
      "clients/mcp/README.md#privacy\n\n─────\nNote for the person running this session.",
    );
  });
});
