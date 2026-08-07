import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActualsResponse, EstimateResponse, LedgerPage } from "@budgetary/sdk";

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
import { runEstimateTool } from "../src/tools/estimate.js";

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

async function estimate(env: NodeJS.ProcessEnv, isVoid = false): Promise<string> {
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
  });
  return r.text;
}

const CC = { BUDGETARY_API_KEY: "bg_test_x", BUDGETARY_HOST: "claude-code" } as NodeJS.ProcessEnv;

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

  it("leaves a VOID's text byte-for-byte unchanged (the 0024c rule)", async () => {
    const voidText = await estimate(CC, true);
    expect(voidText).not.toContain("automatic session-end submission");
    // The marker is untouched, so the notice still reaches the user on their
    // next non-void estimate rather than being silently consumed by the void.
    expect(existsSync(noticeMarkerPath(HOOKLESS_NOTICE, home))).toBe(false);
    const nextText = await estimate(CC);
    expect(nextText).toContain("automatic session-end submission");
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
