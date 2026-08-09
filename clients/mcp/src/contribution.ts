import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readBreadcrumb } from "./breadcrumb.js";
import { budgetaryDir } from "./config.js";

/**
 * Declared by the Claude Code PLUGIN's `.mcp.json`, and by nothing else. A bare
 * `claude mcp add` never sets it, so its presence is a precise, stable statement
 * that the SessionEnd hook ships alongside this server.
 *
 * Deliberately NOT `BUDGETARY_HOST`: the README tells a bare `claude mcp add`
 * user to set `BUDGETARY_HOST=claude-code` too, so that variable says which host
 * this is, never whether the hook is wired — it points the wrong way. This one is
 * set only by an artifact we ship, which is what makes it trustworthy.
 *
 * It is a CAPABILITY DECLARATION, not a credential and not a behavior switch:
 * nothing downstream reads it to decide what to submit, so a user who copies it
 * by hand changes only whether they see a notice — never what reaches the wire.
 */
export const SESSION_END_ENV = "BUDGETARY_SESSION_END";

/** The value {@link SESSION_END_ENV} carries when a session-end hook is wired. */
export const SESSION_END_HOOK = "hook";

export type ContributionStatus =
  /**
   * A session-end hook is wired: completed runs submit themselves.
   *  - `declared` — the plugin manifest that launched us says so.
   *  - `observed` — a session-end run has actually left a breadcrumb here.
   */
  | { kind: "auto"; via: "declared" | "observed" }
  /** No positive evidence of an automatic path. See the note on {@link contributionStatus}. */
  | { kind: "manual-only" };

/**
 * Whether this install has an automatic way to submit a completed run.
 *
 * ★ POSITIVE-ONLY, BY DESIGN. Every signal here can only ever say "yes"; none is
 * inverted into a claim of incapability. `manual-only` means *no evidence was
 * found*, which is emphatically not the same as *the hook is absent* — a hook can
 * be wired in a settings file, a managed policy, or an enabled plugin we never
 * look at, and probing those would couple this package to host internals it does
 * not own and cannot keep up with.
 *
 * That asymmetry decides how the result may be USED: a `manual-only` result may
 * only ever produce an OBSERVATION plus an offer ("no automatic submission has
 * been recorded here; here is how to wire one"). It must never render a verdict
 * ("you cannot contribute"), because the one expensive mistake is telling a user
 * who is already contributing that they are not.
 *
 * Fail-open: any fault resolves to `auto`, so a broken read stays SILENT rather
 * than nagging someone whose setup is fine.
 */
export function contributionStatus(
  env: NodeJS.ProcessEnv,
  home?: string,
): ContributionStatus {
  try {
    if (env[SESSION_END_ENV] === SESSION_END_HOOK) {
      return { kind: "auto", via: "declared" };
    }
    // A breadcrumb exists only because a session-end run wrote one, so ANY
    // breadcrumb — including a `no-key` or `no-entry` outcome — proves the
    // automatic path is invoked on this machine. What it decided is irrelevant
    // here; that it RAN is the whole signal. (`readBreadcrumb` never throws; it
    // returns null when absent, unreadable, or malformed.)
    if (readBreadcrumb(home) !== null) return { kind: "auto", via: "observed" };
    return { kind: "manual-only" };
  } catch {
    // Never nag on a fault.
    return { kind: "auto", via: "observed" };
  }
}

/**
 * Whether Claude Code appears to be installed for this user — the existence of
 * its config directory, nothing more. Used ONLY to decide whether printing a
 * Claude-Code-specific hook recipe is relevant; it is never a contribution
 * signal, and it deliberately reads no file and parses no config.
 *
 * `doctor` runs in the user's SHELL, where `BUDGETARY_HOST` is not set (that
 * variable lives in a host's MCP-server config and reaches only the server
 * child), so `doctor` cannot know which host it is advising. Without this, a
 * Cursor-only machine is told to edit `~/.claude/settings.json` — advice that is
 * simply wrong there.
 *
 * Fails toward SHOWING: any fault returns true. Printing a recipe someone does
 * not need costs a few lines; withholding the one fix they came for costs the
 * contribution.
 */
export function claudeCodePresent(home?: string): boolean {
  try {
    return existsSync(join(home ?? homedir(), ".claude"));
  } catch {
    return true;
  }
}

/**
 * The exact SessionEnd hook to add to `~/.claude/settings.json`, as printable
 * lines. **We only ever PRINT this.** Nothing in this package writes to a user's
 * editor configuration: an unprompted edit of someone's settings is not a fix.
 *
 * The command is deliberately UNPINNED and carries no key. Our own distributed
 * manifests pin `@budgetary/mcp@X` to bound the blast radius of a bad publish,
 * but that pin is maintained by `scripts/sync-mcp-pin.mjs` on every release — a
 * version pasted by hand into a user's settings has no such maintainer and would
 * simply freeze. And the key is read from `~/.budgetary/config.json` rather than
 * interpolated into the command, which keeps it out of the process list.
 */
export function sessionEndHookLines(indent = ""): string[] {
  return [
    `${indent}{`,
    `${indent}  "hooks": {`,
    `${indent}    "SessionEnd": [`,
    `${indent}      {`,
    `${indent}        "matcher": "",`,
    `${indent}        "hooks": [`,
    `${indent}          {`,
    `${indent}            "type": "command",`,
    `${indent}            "command": "npx -y @budgetary/mcp on-session-end",`,
    `${indent}            "timeout": 30`,
    `${indent}          }`,
    `${indent}        ]`,
    `${indent}      }`,
    `${indent}    ]`,
    `${indent}  }`,
    `${indent}}`,
  ];
}

/** Path of the marker recording that a one-time notice has been shown. */
export function noticeMarkerPath(name: string, home?: string): string {
  return join(budgetaryDir(home), `notice-${name}`);
}

/**
 * Claim a ONE-TIME notice: true exactly once per install, false forever after.
 *
 * Uses an exclusive create (`wx`) as the claim itself, so two estimates racing at
 * the same moment cannot both show the notice — the loser gets `EEXIST` and this
 * returns false. Every failure mode collapses to the same safe answer:
 *   - already claimed        → `EEXIST` → false (correct: shown before)
 *   - HOME unwritable/ENOSPC → throws   → false (chosen: stay quiet)
 * Failing toward SILENCE is deliberate. An un-writable marker would otherwise
 * turn a once-only notice into one printed on every single estimate, and the one
 * thing worse than an unmentioned gap is a nag that cannot be dismissed.
 */
export function claimOneTimeNotice(name: string, home?: string): boolean {
  const path = noticeMarkerPath(name, home);
  try {
    const dir = budgetaryDir(home);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `wx` (O_CREAT|O_EXCL): refuses a pre-existing file OR a planted symlink.
    writeFileSync(path, new Date().toISOString(), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The one-time notice name for the hook-less Claude Code contribution gap. */
export const HOOKLESS_NOTICE = "claude-code-session-end";

/**
 * The one-time notice name for the first-run data disclosure.
 *
 * ★ A MODULE CONSTANT, never derived from the host, the key, the version, or
 * anything else that varies. Keying a once-only marker on something variable
 * re-shows the notice every time that thing changes — a user who switches hosts,
 * rotates a key, or upgrades would be told again, which is exactly the
 * un-dismissable nag {@link claimOneTimeNotice} fails toward silence to avoid.
 */
export const DATA_NOTICE = "data-disclosure";

/**
 * What this package transmits, and where the complete account of it lives.
 *
 * ★ THE SINGLE SOURCE. Both surfaces that state it — the one-time block appended
 * to a first estimate, and `doctor`'s unconditional line — compose from this
 * array, so the two cannot drift into separately-maintained copies. Only the
 * lead differs, because only one of them is the disclosure MOMENT.
 *
 * ⚠ It is a DISCLOSURE, not consent. You cannot consent to a transmission that
 * has already happened, and by the time any runtime line can render, `estimate`
 * has already sent the task text. So: no "by continuing you agree", no prompt,
 * no acknowledgement, no opt-in or opt-out language, no terms, no rates, and no
 * commercial statement of any kind. It asks for nothing, gates nothing, grants
 * nothing.
 *
 * ⚠ It claims NO COMPLETENESS OF ITS OWN, and says so in as many words. The
 * estimate also carries a salted project identifier, a host tag, an optional
 * declared language tag, an optional model identifier, and a per-call request
 * id; a block claiming "nothing else leaves this machine" would be false.
 *
 * ⚠ Nor does it promise the README is exhaustive — it points at "a fuller
 * account", not at "every field, named one by one". The earlier wording said
 * the latter and was wrong: the Privacy section it links omitted the host tag,
 * the model identifier, the per-call request id and the declared run ending.
 * (Those are added there in the same change, but the softer promise is what
 * keeps this line true if that list ever falls behind the code again.)
 *
 * ★ It points at the README, not at a terms page. The README is versioned with
 * the code that does the sending, so it is the accurate account — and pointing a
 * runtime disclosure at terms of service would read as an acceptance gesture.
 * There is no `/privacy` page on the site (it 404s); this URL resolves, and its
 * `#privacy` anchor is a real heading in that file.
 *
 * ⚠ The negative claim is deliberately NARROW, because every wider one is false.
 * A step's descriptor keeps an allowlisted program and build/test keyword in the
 * clear and digests everything after, so "never command arguments" is untrue —
 * and so is "never a whole command", because a bare `pytest` or `npm test` is
 * ENTIRELY allowlisted words and reaches the server as written. What the
 * redaction does guarantee is that no file contents and no path ever leave, and
 * that nothing of a command reaches the clear except those allowlisted words.
 * That is what this says; the README carries the rest.
 */
export const DATA_DISCLOSURE_BODY: readonly string[] = [
  "`estimate` sends the task text you pass it to api.budgetary.tools. Recording a finished",
  "run sends that run's token counts, its duration, and — on Claude Code — a redacted step",
  "trace: per step, the tool's name and a digested descriptor of what it acted on. Never",
  "file contents, never a path, and of a command only allowlisted words like `go test`.",
  "That is not the whole list. A fuller account of what this package sends lives here:",
  "https://github.com/thriftell/budgetary-clients/blob/main/clients/mcp/README.md#privacy",
];

/**
 * The one-time block appended to a first successful estimate — the ONLY channel
 * that reaches every MCP host and every install, including one with no
 * session-end hook. A server's stderr lands in a debug log, the MCP handshake
 * renders nothing, and a `SessionEnd` hook's stdout reaches neither the user nor
 * a headless run, so the first tool result is the earliest moment this package
 * owns.
 *
 * ★ And it is ONE CALL LATE. The lead says so rather than engineering around it.
 * The alternative — withholding the first estimate until someone acknowledges a
 * prompt — would gate a call on a disclosure about a transmission that had
 * already happened, which is theatre. Naming the lag is the honest option.
 *
 * It carries NO separator of its own: the `─────` belongs to the hook-less
 * notice, which stays visually last.
 */
export function dataDisclosureLines(): string[] {
  return [
    // Addressed to the human in the first words, for the same reason the
    // hook-less notice is: this text is appended to a tool result, so it lands
    // in the model's context too, and naming the reader keeps it legible as a
    // status note rather than an instruction to the assistant. Nothing in it is
    // actionable by a model.
    // ★ Names the LAG. It does not restate the transmission — the body's first
    // sentence does that, and saying "already sent its task text" here put the
    // same fact on two consecutive lines.
    "One-time note for the person running this session — the first thing this package can show",
    "you, and so one estimate late: the call you just made has already gone out.",
    ...DATA_DISCLOSURE_BODY,
  ];
}

/**
 * The one-time notice a hook-less Claude Code install sees, appended to its first
 * estimate. States what is missing and what it costs the user — their completed
 * runs cannot improve future estimates — then gives both fixes.
 *
 * ⚠ Every line here is subject to the copy gates: it describes an INSTALL STATE
 * and nothing else. No pricing, tier, licence, availability, or timeline claim;
 * nothing about what the corpus holds, how well anything is covered, or how often
 * an estimate abstains. And it is phrased as an observation plus an offer, never
 * a verdict — see {@link contributionStatus}.
 */
export function hooklessNoticeLines(): string[] {
  return [
    "─────",
    // Addressed to the human, explicitly. This text is appended to a tool result,
    // so it lands in the model's context as well; naming the reader keeps it
    // legible as a status note to the user rather than an instruction to the
    // assistant. (Nothing here is actionable by a model: the command below
    // carries placeholders, and no path in this package accepts a count from
    // one.)
    "Note for the person running this session.",
    "",
    "No automatic session-end submission has been recorded on this machine. If you",
    "installed with `claude mcp add`, that command wires the estimate tool only — so",
    "nothing will submit this run's real token counts when it finishes, and a completed",
    "run cannot improve future estimates unless it is submitted. Two ways to do that:",
    "",
    "1. Automatic — add this SessionEnd hook to ~/.claude/settings.json (or install the",
    "   Budgetary plugin, which ships it). Nothing writes this for you:",
    ...sessionEndHookLines("     "),
    "   The hook reads your key from ~/.budgetary/config.json, so it stays out of the",
    // Not "verify with doctor": nothing reads your Claude Code config, so doctor
    // cannot confirm a hook is wired — only that one has run. Promising otherwise
    // sends the user to a command that answers a different question and reads as
    // "my edit failed".
    "   process list. After your next session ends, `npx @budgetary/mcp doctor` shows",
    "   the run under 'Last auto:'.",
    "",
    "2. By hand, after a session ends — real counts measured from the transcript, not",
    "   typed. Run this from the directory you estimated in, naming a FINISHED session:",
    "     npx @budgetary/mcp on-session-end --transcript ~/.claude/projects/<project>/<session-id>.jsonl",
    "",
    "Shown once. `npx @budgetary/mcp doctor` repeats it any time.",
  ];
}
