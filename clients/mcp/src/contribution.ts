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
