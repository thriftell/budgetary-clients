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

import type { ActualsResponse, EstimateResponse, LedgerPage } from "@budgetary/sdk";
import { BudgetaryAuthError } from "@budgetary/sdk";

import { writeBreadcrumb } from "../src/breadcrumb.js";
import {
  claimOneTimeNotice,
  claudeCodePresent,
  contributionStatus,
  HOOKLESS_NOTICE,
  hooklessNoticeLines,
  noticeMarkerPath,
  SESSION_END_ENV,
  SESSION_END_HOOK,
  sessionEndHookLines,
} from "../src/contribution.js";
import { runDoctor } from "../src/doctor.js";
import {
  projectIdFromCwd,
  runEstimateTool,
  type HandshakeClientInfo,
} from "../src/tools/estimate.js";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-contrib-"));
  cwd = mkdtempSync(join(tmpdir(), "budgetary-contrib-cwd-"));
  mkdirSync(join(home, ".budgetary"), { recursive: true });
});

afterEach(() => {
  // Restore any mode we tightened so the tree is removable.
  try {
    chmodSync(join(home, ".budgetary"), 0o700);
  } catch {
    // already gone / already writable
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// contributionStatus — positive-only capability detection
// ---------------------------------------------------------------------------

describe("contributionStatus", () => {
  it("reads the plugin's declaration as capable", () => {
    expect(contributionStatus({ [SESSION_END_ENV]: SESSION_END_HOOK }, home)).toEqual({
      kind: "auto",
      via: "declared",
    });
  });

  it("treats ANY breadcrumb as proof the automatic path runs here", () => {
    // Deliberately the LEAST successful outcome: what the run decided is
    // irrelevant, that it RAN is the entire signal.
    writeBreadcrumb(home, { startedAt: "2026-08-01T00:00:00Z", outcome: "no-key" });
    expect(contributionStatus({}, home)).toEqual({ kind: "auto", via: "observed" });
  });

  it("reports manual-only when there is no positive evidence at all", () => {
    expect(contributionStatus({}, home)).toEqual({ kind: "manual-only" });
  });

  it("ignores a wrong value for the declaration env var", () => {
    expect(contributionStatus({ [SESSION_END_ENV]: "yes" }, home).kind).toBe("manual-only");
    expect(contributionStatus({ [SESSION_END_ENV]: "" }, home).kind).toBe("manual-only");
  });

  it("does NOT use BUDGETARY_HOST as a discriminator", () => {
    // README tells a BARE `claude mcp add` install to set this too, so it says
    // which host this is and never whether a hook is wired. If it ever leaked
    // into the signal, every hook-less Claude Code user would be silently
    // classified capable — the exact failure this item exists to fix.
    expect(contributionStatus({ BUDGETARY_HOST: "claude-code" }, home).kind).toBe(
      "manual-only",
    );
  });

  it("fails OPEN (stays silent) when the breadcrumb read throws", () => {
    // A fault must never turn into a nag at someone whose setup is fine.
    const boom = { get BUDGETARY_SESSION_END(): string { throw new Error("boom"); } };
    expect(contributionStatus(boom as unknown as NodeJS.ProcessEnv, home).kind).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// claimOneTimeNotice — the once-only claim
// ---------------------------------------------------------------------------

describe("claimOneTimeNotice", () => {
  it("returns true exactly once, then false forever", () => {
    expect(claimOneTimeNotice("t", home)).toBe(true);
    expect(claimOneTimeNotice("t", home)).toBe(false);
    expect(claimOneTimeNotice("t", home)).toBe(false);
    expect(existsSync(noticeMarkerPath("t", home))).toBe(true);
  });

  it("writes the marker owner-only", () => {
    claimOneTimeNotice("t", home);
    expect(statSync(noticeMarkerPath("t", home)).mode & 0o777).toBe(0o600);
  });

  it("keeps distinct notices independent", () => {
    expect(claimOneTimeNotice("a", home)).toBe(true);
    expect(claimOneTimeNotice("b", home)).toBe(true);
  });

  it("fails toward SILENCE when the marker cannot be written", () => {
    // An un-writable marker would otherwise turn a once-only notice into one
    // printed on every estimate — a nag that cannot be dismissed.
    chmodSync(join(home, ".budgetary"), 0o500);
    expect(claimOneTimeNotice("t", home)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// claudeCodePresent — relevance only, never a contribution signal
// ---------------------------------------------------------------------------

describe("claudeCodePresent", () => {
  it("is false when the host's config dir does not exist", () => {
    expect(claudeCodePresent(home)).toBe(false);
  });

  it("is true once it does", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(claudeCodePresent(home)).toBe(true);
  });

  it("never becomes a contribution signal", () => {
    // Having Claude Code installed says nothing about whether a hook is wired.
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(contributionStatus({}, home).kind).toBe("manual-only");
  });
});

// ---------------------------------------------------------------------------
// The printed hook config — we PRINT, we never WRITE
// ---------------------------------------------------------------------------

describe("sessionEndHookLines", () => {
  it("is valid JSON declaring a SessionEnd command hook", () => {
    const parsed = JSON.parse(sessionEndHookLines().join("\n")) as {
      hooks: { SessionEnd: { hooks: { type: string; command: string; timeout: number }[] }[] };
    };
    const inner = parsed.hooks.SessionEnd[0]!.hooks[0]!;
    expect(inner.type).toBe("command");
    expect(inner.command).toContain("on-session-end");
    expect(inner.timeout).toBe(30);
  });

  it("carries no API key and no key interpolation", () => {
    const text = sessionEndHookLines().join("\n");
    expect(text).not.toContain("BUDGETARY_API_KEY");
    expect(text).not.toContain("user_config");
    expect(text).not.toContain("bg_live_");
    expect(text).not.toContain("bg_test_");
  });

  it("is unpinned — a hand-pasted version would have no maintainer", () => {
    // scripts/sync-mcp-pin.mjs keeps OUR distributed manifests pinned on every
    // release. A pin pasted into a user's own settings.json is updated by nobody
    // and would simply freeze, so this snippet deliberately omits one.
    expect(sessionEndHookLines().join("\n")).not.toMatch(/@budgetary\/mcp@\d/);
  });

  it("indents every line when asked", () => {
    for (const line of sessionEndHookLines("  ")) expect(line.startsWith("  ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Copy gates — these strings are published to a PUBLIC repo
// ---------------------------------------------------------------------------

describe("notice copy obeys the gates", () => {
  const allCopy = () => [...hooklessNoticeLines(), ...sessionEndHookLines()].join("\n").toLowerCase();

  it("makes no commercial claim", () => {
    // This copy describes an install state and nothing else: no pricing, tier,
    // licence, availability, or timeline claim.
    for (const word of [
      "price", "pricing", "free tier", "paid", "plan", "subscription", "trial",
      "licence", "license", "enterprise", "soon", "roadmap", "beta", "$",
    ]) {
      expect(allCopy()).not.toContain(word);
    }
  });

  it("discloses nothing about the corpus, coverage, or abstention", () => {
    // A pushed branch in a public repo discloses before any merge. The copy may
    // describe THIS INSTALL and must say nothing about the state of the data
    // behind the service. Kept to direction-agnostic nouns on purpose: a denylist
    // that named a particular sentence would gesture at the sentence.
    for (const word of [
      "corpus", "coverage", "void rate", "benchmark", "calibration set",
      "rows", "dataset",
    ]) {
      expect(allCopy()).not.toContain(word);
    }
  });

  it("states the user-facing cost without quoting a measurement", () => {
    const text = hooklessNoticeLines().join("\n");
    expect(text).toContain("cannot improve future estimates");
    // No count or percentage in the PROSE. The embedded hook config is exempt —
    // its only number is the hook's own `"timeout": 30`.
    const hookJson = new Set(sessionEndHookLines("     "));
    const prose = hooklessNoticeLines().filter((l) => !hookJson.has(l));
    expect(prose.join("\n")).not.toMatch(/\b\d{2,}\b|%/);
  });

  it("offers both fixes and tells the user nothing is written for them", () => {
    const text = hooklessNoticeLines().join("\n");
    expect(text).toContain("~/.claude/settings.json");
    expect(text).toContain("Nothing writes this for you");
    expect(text).toContain("on-session-end --transcript");
    expect(text).toContain("doctor");
  });
});

// ---------------------------------------------------------------------------
// doctor — the state it could not previously report
// ---------------------------------------------------------------------------

function ledgerOk() {
  return {
    estimate: vi.fn(),
    submitActuals: vi.fn(async (): Promise<ActualsResponse> => ({ received: true, ledgerEntryId: "l" })),
    getLedger: vi.fn(async (): Promise<LedgerPage> => ({ entries: [], nextCursor: null })),
  };
}

async function doctor(env: NodeJS.ProcessEnv): Promise<string> {
  const lines: string[] = [];
  await runDoctor({
    env,
    home,
    now: () => new Date("2026-08-07T10:00:00Z"),
    out: (l) => lines.push(l),
    clientFactory: () => ledgerOk() as never,
  });
  return lines.join("\n");
}

/** Give the fake HOME a Claude Code config dir, as a real Claude Code user has. */
function withClaudeCode() {
  mkdirSync(join(home, ".claude"), { recursive: true });
}

describe("runDoctor — contribution capability", () => {
  it("tells a hook-less install what is missing, what it costs, and both fixes", async () => {
    withClaudeCode();
    const text = await doctor({ BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv);
    expect(text).toContain("no automatic session-end submission has been recorded");
    expect(text).toContain("cannot improve future estimates");
    expect(text).toContain("~/.claude/settings.json");
    expect(text).toContain("nothing writes it for you");
    expect(text).toContain("on-session-end --transcript");
  });

  it("says a just-wired hook showing nothing yet is EXPECTED", async () => {
    // The signal is retrospective, so a correctly wired hook reads as "nothing
    // recorded" until it first fires. Without this line the user concludes their
    // edit failed and undoes the fix.
    withClaudeCode();
    const text = await doctor({ BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv);
    expect(text).toContain("that is expected");
    expect(text).toContain("until your next session ends");
  });

  it("keeps the cost CONDITIONAL, because manual submits leave no breadcrumb", async () => {
    // `report-actual` and `on-session-end --transcript` submit real actuals and
    // write no breadcrumb, so this block never retracts for someone using them.
    // An unconditional "completed runs are never submitted" would be permanently
    // FALSE for every manual host.
    const text = await doctor({ BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv);
    expect(text).toContain("unless it is submitted");
    expect(text).not.toContain("completed runs are never submitted");
  });

  it("omits the Claude Code hook recipe on a machine without Claude Code", async () => {
    // `doctor` runs in the user's shell, where BUDGETARY_HOST is not set, so it
    // cannot know the host. Telling a Cursor-only machine to edit
    // ~/.claude/settings.json is simply wrong advice.
    const text = await doctor({ BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv);
    expect(text).not.toContain("~/.claude/settings.json");
    expect(text).not.toContain('"SessionEnd"');
    // …but the routes that DO apply to such a host are still offered.
    expect(text).toContain("report-actual");
    expect(text).toContain("Codex:");
    expect(text).toContain("no automatic session-end submission has been recorded");
  });

  it("says nothing about wiring a hook when the plugin declared one", async () => {
    const text = await doctor({
      BUDGETARY_API_KEY: "bg_test_x",
      [SESSION_END_ENV]: SESSION_END_HOOK,
    } as NodeJS.ProcessEnv);
    expect(text).toContain("Actuals:   automatic");
    expect(text).not.toContain("~/.claude/settings.json");
    expect(text).not.toContain("cannot improve future estimates");
  });

  it("says nothing about wiring a hook once a session-end run has been recorded", async () => {
    writeBreadcrumb(home, { startedAt: "2026-08-07T09:00:00Z", outcome: "submitted" });
    const text = await doctor({ BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv);
    expect(text).toContain("Actuals:   automatic");
    expect(text).not.toContain("~/.claude/settings.json");
  });

  it("reports it on the NO-KEY branch too — an unfinished setup needs it most", async () => {
    const text = await doctor({} as NodeJS.ProcessEnv);
    expect(text).toContain("(none configured)");
    expect(text).toContain("no automatic session-end submission has been recorded");
  });

  it("cites its evidence rather than asserting a hook it never verified", async () => {
    const text = await doctor({
      BUDGETARY_API_KEY: "bg_test_x",
      [SESSION_END_ENV]: SESSION_END_HOOK,
    } as NodeJS.ProcessEnv);
    expect(text).toContain("the launching manifest declares");
    expect(text).not.toContain("a session-end hook is wired");
  });

  it("never phrases the gap as a verdict about the user", async () => {
    // Detection is positive-only and cannot prove absence, so the copy may only
    // observe and offer. Telling a user who IS contributing that they are not is
    // the one expensive mistake.
    const text = await doctor({ BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv);
    expect(text).not.toContain("you cannot contribute");
    expect(text).not.toContain("no hook is installed");
    expect(text).not.toContain("you have not");
  });
});

// ---------------------------------------------------------------------------
// The estimate path — once for the dead end, NOTHING new on the working path
// ---------------------------------------------------------------------------

function estimateResponse(isVoid = false): EstimateResponse {
  return isVoid
    ? {
        estimateId: "est_void",
        scenario: "out_of_domain",
        void: true,
        distribution: null,
        confidence: 0,
        model: "claude-opus-4-7",
        expiresAt: "2026-08-08T10:00:00Z",
      }
    : {
        estimateId: "est_1",
        scenario: "confident",
        void: false,
        distribution: { p10: 1000, p50: 4000, p90: 20000, unit: "tokens" },
        confidence: 0.7,
        model: "claude-opus-4-7",
        expiresAt: "2026-08-08T10:00:00Z",
      };
}

async function estimate(
  env: NodeJS.ProcessEnv,
  isVoid = false,
  clientInfo?: HandshakeClientInfo,
): Promise<string> {
  const client = {
    estimate: vi.fn(async () => estimateResponse(isVoid)),
    submitActuals: vi.fn(),
    getLedger: vi.fn(),
  };
  const r = await runEstimateTool({
    query: "add a flag",
    env,
    cwd,
    home,
    clientFactory: () => client as never,
    ...(clientInfo !== undefined ? { clientInfo } : {}),
  });
  return r.text;
}

const CC = { BUDGETARY_API_KEY: "bg_test_x", BUDGETARY_HOST: "claude-code" } as NodeJS.ProcessEnv;

/**
 * A void estimate's user-facing message, verbatim — the exact two lines `main`
 * rendered before the notice was allowed beneath one.
 *
 * TRANSCRIBED rather than imported from `renderEstimate` on purpose: the point of
 * these assertions is that the void's own text did not move, and computing the
 * expectation from the same function that produces it would pass no matter what
 * that copy became. Held here, a change to either side fails loudly — which is
 * what should happen, since rewriting the void's message belongs to 0026b, not
 * to a change that only stops suppressing a block underneath it.
 */
const VOID_TEXT =
  "Budgetary cannot confidently estimate this query (out of domain).\n" +
  "This estimate wasn't billed. Proceed without a prediction — at your own judgment.";

/**
 * What a void renders BENEATH that message since 0026c: after the blank-line
 * seam, the estimate id, the host's existing stored footer, and one sentence on
 * what a recorded run returns. The footers are transcribed for the same reason
 * `VOID_TEXT` is — an expectation computed from `storedFooter` would pass
 * whatever that copy became, and these assertions exist to notice.
 *
 * The notice is NOT part of this: it is appended after, and stays last.
 */
const CC_FOOTER = [
  "Pending estimate stored. With the Budgetary plugin installed, actuals are",
  "recorded automatically at session end — otherwise run `npx @budgetary/mcp report-actual`.",
];
const DEFAULT_FOOTER = [
  "Pending estimate stored. After the run, record actuals with",
  "`npx @budgetary/mcp report-actual`.",
];
const CODEX_FOOTER = [
  "Pending estimate stored. After the run, record actuals with",
  "`npx @budgetary/mcp on-session-end --transcript <rollout>` (or `report-actual`).",
];

function voidRender(footer: string[] = CC_FOOTER): string {
  return [
    VOID_TEXT,
    "",
    "Estimate id: est_void",
    "",
    ...footer,
    "When this run's token counts are recorded, its measured breakdown appears here.",
  ].join("\n");
}

describe("estimate — the one-time hook-less notice", () => {
  it("shows it once on a hook-less Claude Code install, then never again", async () => {
    const first = await estimate(CC);
    expect(first).toContain("automatic session-end submission has been recorded");
    expect(first).toContain("cannot improve future estimates");

    const second = await estimate(CC);
    expect(second).not.toContain("automatic session-end submission has been recorded");
  });

  it("shows NOTHING new when the plugin declared a hook — the working path", async () => {
    const text = await estimate({ ...CC, [SESSION_END_ENV]: SESSION_END_HOOK });
    expect(text).not.toContain("automatic session-end submission");
    expect(text).not.toContain("~/.claude/settings.json");
    // And it did not burn the marker, so the notice is still available if that
    // install ever loses its hook.
    expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);
  });

  it("shows NOTHING new once a session-end run has been recorded", async () => {
    writeBreadcrumb(home, { startedAt: "2026-08-07T09:00:00Z", outcome: "submitted" });
    const text = await estimate(CC);
    expect(text).not.toContain("automatic session-end submission");
  });

  it("shows NOTHING new on any other host", async () => {
    for (const host of [undefined, "codex", "cursor", "copilot"]) {
      const env = { BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv;
      if (host !== undefined) env.BUDGETARY_HOST = host;
      const text = await estimate(env);
      expect(text).not.toContain("automatic session-end submission");
      expect(text).not.toContain("~/.claude/settings.json");
    }
  });

  it("APPENDS the notice beneath a VOID, leaving the void's own message byte-identical", async () => {
    // The notice used to be suppressed on a void. It no longer is: whether a run
    // can be submitted is a property of the install, not of whether this query
    // could be forecast. What the 0024c rule protects is the void's MESSAGE, and
    // this is an append — proven by exact equality below, not by a `toContain`.
    const voidText = await estimate(CC, true);
    expect(voidText).toBe(`${voidRender()}\n\n${hooklessNoticeLines().join("\n")}`);
    // Stated separately so a failure says which half broke: the message is a
    // byte-identical PREFIX, and everything else is strictly beneath it.
    expect(voidText.startsWith(`${VOID_TEXT}\n\n`)).toBe(true);
    expect(voidText.slice(0, VOID_TEXT.length)).toBe(VOID_TEXT);
    expect(Buffer.from(voidText, "utf8").subarray(0, 149).toString("utf8")).toBe(
      VOID_TEXT,
    );
  });

  it("keeps the notice VISUALLY LAST when both fire — id and footer come first", async () => {
    // ★ The claim this item flagged as most likely to be wrong: that appending
    // beneath the void still reads well once the one-time notice also fires. It
    // is settled by rendering, not by reasoning — the full output is asserted
    // above; here the ORDER is pinned so a later edit cannot quietly interleave
    // the two blocks.
    const text = await estimate(CC, true);
    const idAt = text.indexOf("Estimate id: est_void");
    const footerAt = text.indexOf("Pending estimate stored.");
    const measuredAt = text.indexOf("When this run's token counts are recorded");
    const separatorAt = text.indexOf("\n─────\n");
    for (const at of [idAt, footerAt, measuredAt, separatorAt]) expect(at).toBeGreaterThan(-1);
    expect(idAt).toBeGreaterThan(VOID_TEXT.length - 1);
    expect(footerAt).toBeGreaterThan(idAt);
    expect(measuredAt).toBeGreaterThan(footerAt);
    // The `─────` block opens after everything 0026c appends…
    expect(separatorAt).toBeGreaterThan(measuredAt);
    // …and closes the message: the notice is the last thing on screen, exactly as
    // it ships today.
    expect(text.endsWith(hooklessNoticeLines().join("\n"))).toBe(true);
    // One blank line between the two blocks — never a run-on, never a double gap.
    expect(text).toContain(
      "its measured breakdown appears here.\n\n─────\nNote for the person running this session.",
    );
  });

  it("still shows it ONCE — a void burns the marker exactly as a priced estimate does", async () => {
    const first = await estimate(CC, true);
    expect(first).toContain("automatic session-end submission has been recorded");
    // Neither a second void nor a later priced estimate repeats it. Firing on the
    // void must not turn a once-only notice into a per-estimate nag.
    expect(await estimate(CC, true)).toBe(voidRender());
    expect(await estimate(CC)).not.toContain("automatic session-end submission");
  });

  it("shows NOTHING new on a VOID when the plugin declared a hook — the working path", async () => {
    // The suppression conditions are unchanged, so an install that CAN contribute
    // sees the void and its own footer, and keeps its marker unspent.
    const text = await estimate({ ...CC, [SESSION_END_ENV]: SESSION_END_HOOK }, true);
    expect(text).toBe(voidRender());
    expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);
  });

  it("shows NOTHING new on a VOID once a session-end run has been recorded", async () => {
    writeBreadcrumb(home, { startedAt: "2026-08-07T09:00:00Z", outcome: "submitted" });
    expect(await estimate(CC, true)).toBe(voidRender());
    expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);
  });

  it("shows NOTHING new on a VOID on any other host", async () => {
    for (const host of [undefined, "codex", "cursor", "copilot"]) {
      const env = { BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv;
      if (host !== undefined) env.BUDGETARY_HOST = host;
      // Each host gets ITS OWN existing footer beneath the void — the same lines
      // it already prints on a priced estimate, produced by the same function.
      expect(await estimate(env, true)).toBe(
        voidRender(host === "codex" ? CODEX_FOOTER : DEFAULT_FOOTER),
      );
      expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);
    }
  });

  it("appends the notice and NOTHING ELSE — the pending-hygiene nudges stay off a void", async () => {
    // This project already has an unexpired pending estimate, so a PRICED estimate
    // here would append "earlier estimates await actuals". A void must still not:
    // only the notice may follow the void's message, and only beneath it.
    writeFileSync(
      join(home, ".budgetary", "pending.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            estimate_id: "est_prior",
            query: "an earlier task",
            project_id: projectIdFromCwd(cwd, home),
            created_at: new Date(Date.now() - 60_000).toISOString(),
            attempts: 0,
          },
        ],
      }),
      "utf8",
    );
    const text = await estimate(CC, true);
    expect(text).toBe(`${voidRender()}\n\n${hooklessNoticeLines().join("\n")}`);
    expect(text).not.toContain("await actuals");
  });

  it("never lets the notice turn an estimate into an error", async () => {
    const client = {
      estimate: vi.fn(async () => estimateResponse()),
      submitActuals: vi.fn(),
      getLedger: vi.fn(),
    };
    const r = await runEstimateTool({
      query: "x",
      env: CC,
      cwd,
      home,
      clientFactory: () => client as never,
    });
    expect(r.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 0024d-3 — the handshake reaches the notice gate, and nothing else
// ---------------------------------------------------------------------------

/** An env with a key and NO BUDGETARY_HOST — the advertised-install shape. */
const KEY_ONLY = { BUDGETARY_API_KEY: "bg_test_x" } as NodeJS.ProcessEnv;
/** The one verified handshake identity, as Claude Code sends it. */
const ATTESTED: HandshakeClientInfo = { name: "claude-code" };
/** A phrase only the hook-less notice contains. */
const NOTICE = "automatic session-end submission has been recorded";

describe("estimate — handshake host detection (0024d-3)", () => {
  it("fires the notice for an env-unset install whose handshake attests claude-code", async () => {
    // The point of the item: the population the notice was written for is
    // definitionally the env-unset one, and the handshake now reaches it.
    const first = await estimate(KEY_ONLY, false, ATTESTED);
    expect(first).toContain(NOTICE);
    // Still once per install — the same marker, the same claim.
    const second = await estimate(KEY_ONLY, false, ATTESTED);
    expect(second).not.toContain(NOTICE);
  });

  it("still fires when the operator declared claude-code, whatever the handshake says", async () => {
    // Today's two cases, unregressed: a declared claude-code install keeps its
    // notice whether the handshake agrees, disagrees, or is absent (wrappers,
    // proxies, a harness fronting Claude Code).
    for (const clientInfo of [
      undefined,
      { name: "claude-code" },
      { name: "codex-mcp-client" },
    ]) {
      const text = await estimate(CC, false, clientInfo);
      expect(text).toContain(NOTICE);
      rmSync(noticeMarkerPath(HOOKLESS_NOTICE, home)); // fresh marker per case
    }
  });

  it("an explicit non-claude-code BUDGETARY_HOST suppresses it under a claude-code handshake", async () => {
    // The contested precedence case: env wins. BUDGETARY_HOST is the only knob
    // the operator has; if the handshake could override it, a wrong or unwanted
    // attestation would be uncorrectable by anyone.
    const env = {
      BUDGETARY_API_KEY: "bg_test_x",
      BUDGETARY_HOST: "codex",
    } as NodeJS.ProcessEnv;
    const text = await estimate(env, false, ATTESTED);
    expect(text).not.toContain(NOTICE);
    // And the marker is unspent — the declaration decided, recoverably.
    expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);
  });

  it("unknown, absent, malformed, empty and case-differing handshakes assert nothing", async () => {
    // Positive-only, in every direction: none of these is "not Claude Code" —
    // each is *unknown*, so with the env unset the behaviour is exactly today's.
    // `Claude Code` (title case, space) is a REAL identity of the same product
    // on a different channel; it must still not match — exact equality only.
    for (const clientInfo of [
      undefined,
      {},
      { name: "" },
      { name: "codex-mcp-client" },
      { name: "Visual Studio Code" },
      { name: "Claude Code" },
      { name: "CLAUDE-CODE" },
      { name: " claude-code" },
      { name: "claude-code\n" },
      { name: 42 },
      { name: "x".repeat(100_000) },
    ]) {
      const text = await estimate(KEY_ONLY, false, clientInfo);
      expect(text).not.toContain(NOTICE);
      expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);
    }
  });

  it("a weird handshake never suppresses the notice the env var already earned", async () => {
    // Absence (or garbage) only fails to widen — it must never subtract.
    for (const clientInfo of [{}, { name: "" }, { name: "codex-mcp-client" }, { name: 42 }]) {
      const text = await estimate(CC, false, clientInfo);
      expect(text).toContain(NOTICE);
      rmSync(noticeMarkerPath(HOOKLESS_NOTICE, home)); // fresh marker per case
    }
  });

  it("keeps the DEFAULT stored footer — a handshake-detected install is provably not the plugin", async () => {
    // The plugin's own manifest sets BUDGETARY_HOST; this install has none. So
    // the claude-code footer's "With the Budgetary plugin installed, actuals
    // are recorded automatically" would be a downgrade — the generic
    // `report-actual` line is strictly more actionable here.
    const text = await estimate(KEY_ONLY, false, ATTESTED);
    expect(text).toContain("After the run, record actuals with");
    // The notice's own copy may mention the plugin as a FIX; the claude-code
    // FOOTER's opening claim is what must not appear.
    expect(text).not.toContain("With the Budgetary plugin installed");
  });

  it("keeps the generic no-key guidance — /plugin configure cannot work for a non-plugin install", async () => {
    const text = await estimate({} as NodeJS.ProcessEnv, false, ATTESTED);
    expect(text).toContain("Set one of the following");
    expect(text).not.toContain("/plugin configure");
  });

  it("keeps the generic 401 fix line for the same reason", async () => {
    const client = {
      estimate: vi.fn(async () => {
        throw new BudgetaryAuthError({
          code: "authentication_failed",
          message: "bad key",
          httpStatus: 401,
          requestId: "req_401",
        });
      }),
      submitActuals: vi.fn(),
      getLedger: vi.fn(),
    };
    const r = await runEstimateTool({
      query: "x",
      env: KEY_ONLY,
      cwd,
      home,
      clientFactory: () => client as never,
      clientInfo: ATTESTED,
    });
    expect(r.text).toContain("was rejected");
    expect(r.text).not.toContain("/plugin configure");
  });

  it("shows nothing new to a user who already saw it under the env var — same marker", async () => {
    // Idempotency across the upgrade, free BECAUSE the marker is a module
    // constant and not keyed on the attested name.
    const first = await estimate(CC);
    expect(first).toContain(NOTICE);
    const second = await estimate(KEY_ONLY, false, ATTESTED);
    expect(second).not.toContain(NOTICE);
  });

  it("APPENDS the notice beneath a VOID for a handshake-detected install — void text byte-identical", async () => {
    // 0024d-2 preserved: the notice still fires beneath a void, and the void's
    // own message is untouched. The footer beneath it is the DEFAULT one — the
    // recorded host is still "mcp", so even on this path no render widened.
    const text = await estimate(KEY_ONLY, true, ATTESTED);
    expect(text).toBe(
      `${voidRender(DEFAULT_FOOTER)}\n\n${hooklessNoticeLines().join("\n")}`,
    );
    expect(Buffer.from(text, "utf8").subarray(0, 149).toString("utf8")).toBe(
      VOID_TEXT,
    );
  });

  it("shows NOTHING to a wired install, however the handshake attests", async () => {
    // The capability gate is untouched: a host identity says WHICH host, never
    // WHETHER anything is wired. Declared hook first, then breadcrumb-observed.
    const declared = await estimate(
      { ...KEY_ONLY, [SESSION_END_ENV]: SESSION_END_HOOK } as NodeJS.ProcessEnv,
      false,
      ATTESTED,
    );
    expect(declared).not.toContain(NOTICE);
    expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);

    writeBreadcrumb(home, { startedAt: "2026-08-07T09:00:00Z", outcome: "submitted" });
    const observed = await estimate(KEY_ONLY, false, ATTESTED);
    expect(observed).not.toContain(NOTICE);
    expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);
  });

  it("never echoes the raw attested name — compared and discarded", async () => {
    // `clientInfo.name` is unvalidated wire input (empty, huge, ANSI escapes
    // all parse). It may be compared against the allowlist and nothing else.
    const hostile = "\u001b[31mpwned-by-handshake\u001b[0m";
    const silent = await estimate(KEY_ONLY, false, { name: hostile });
    expect(silent).not.toContain("pwned-by-handshake");
    expect(silent).not.toContain("\u001b");
    // Even when the notice DOES fire (env-earned), the name goes nowhere…
    const shown = await estimate(CC, false, { name: hostile });
    expect(shown).toContain(NOTICE);
    expect(shown).not.toContain("pwned-by-handshake");
    // …including into the pending store.
    const pending = readFileSync(join(home, ".budgetary", "pending.json"), "utf8");
    expect(pending).not.toContain("pwned-by-handshake");
  });
});
