# Runbook — Codex plugin marketplace & directory submission

This is the procedure for distributing the **Budgetary** Codex plugin: the
self-hosted marketplace that ships from this repository, and the (deferred)
submission to OpenAI's official Codex plugin directory.

> **Scope.** This covers the Codex plugin (0014b-3) only. The MCP registry
> listing (0014b-1) and the Claude Code marketplace (0014b-2) are separate work,
> covered in [`mcp-registry-runbook.md`](./mcp-registry-runbook.md) and
> [`claude-code-plugin-runbook.md`](./claude-code-plugin-runbook.md).

> **Re-verify before relying on this.** Codex's plugin system is new and moving
> fast, and the **shipping CLI diverges from the published docs** (see below).
> The facts here were verified against `developers.openai.com/codex/*`, the
> Codex-bundled `plugin-creator` system skill (its `validate_plugin.py` /
> `create_basic_plugin.py`), the installed `github@openai-curated` plugin, and a
> real `codex-cli` **0.40.0** on 2026-06-12. Re-check before each submission.

---

## What's in the repo

- [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json) — the
  repo-root marketplace catalog (Codex reads `.agents/plugins/marketplace.json`,
  **not** `.claude-plugin/`). One plugin entry, `source: { source: "local", path:
  "./clients/codex" }`.
- [`clients/codex/.codex-plugin/plugin.json`](../clients/codex/.codex-plugin/plugin.json)
  — the plugin manifest: metadata + a required `interface` block + `skills` +
  `mcpServers`. **No `hooks` field** (Codex plugin validation rejects it).
- [`clients/codex/.mcp.json`](../clients/codex/.mcp.json) — the MCP server
  (`npx -y @budgetary/mcp`), which exposes the `estimate` tool.
- [`clients/codex/skills/estimate/SKILL.md`](../clients/codex/skills/estimate/SKILL.md)
  — the `estimate` skill (delegates to the MCP `estimate` tool).

The plugin carries no build artifacts: everything executable runs from the
published [`@budgetary/mcp`](https://www.npmjs.com/package/@budgetary/mcp) npm
package via `npx`, so a git-cloned/copied install works without `dist/` or
`node_modules/`.

## Docs-vs-runtime divergence (read this first)

The b-2 lesson — *the docs diverge from the runtime; the install is the arbiter* —
applies doubly here. Where they disagree, **the shipping CLI and the official
validator win**:

| Topic | `developers.openai.com/codex/plugins/build` says | Shipping runtime (CLI 0.40.0 + bundled `validate_plugin.py`) | We follow |
|---|---|---|---|
| `hooks` manifest field | listed as an optional field; `SessionStart`/`SessionEnd` events | **rejected** — `hooks` is not in the validator's allow-list; `--with-hooks` scaffolds only an empty dir; the binary has no session-end event string | **omit `hooks`** |
| `.mcp.json` top-level key | `mcp_servers` (snake_case) or a direct map | validator accepts **only `mcpServers`** (camelCase) | **`mcpServers`** |
| Plugin components | Skills, Apps, MCP servers, hooks | Skills, Apps, MCP servers (the plugins overview page omits hooks too) | skills + MCP server |
| `codex plugin marketplace add …` | documented CLI | **absent on 0.40.0** (`unexpected argument 'marketplace'`) | install from local clone until the CLI ships it |

### The actuals path — the crux

The Claude Code plugin (b-2) submits real, transcript-derived actuals from a
`SessionEnd` hook. **Codex has no equivalent plugin hook on the shipping CLI**, so
this plugin is **estimate-only**:

- Codex plugin **validation rejects a `hooks` field** (confirmed in the bundled
  `validate_plugin.py` allow-list: `id, name, version, description, skills, apps,
  mcpServers, interface, author, homepage, repository, license, keywords`).
- The `plugin-creator` skill explicitly says to *"omit unsupported plugin
  manifest fields that validation rejects, including `hooks`."*
- The scaffolder's `--with-hooks` flag creates only an **empty `hooks/`
  directory** (unlike `--with-mcp`/`--with-apps`, which write real stub files).
- OpenAI's own flagship `github@openai-curated` plugin declares **no hooks**, and
  the official plugins overview lists plugin components as **Skills / Apps / MCP
  servers** only.
- The `codex-cli 0.40.0` binary contains no `SessionStart`/`SessionEnd`/`Stop`
  hook-event strings.

We therefore **do not ship a `SessionEnd`/`Stop` hook**: a hook the host never
fires would be dead weight, and fabricating a token count is never acceptable
(the 0012 actuals invariant: actuals are real, measured, fail-closed, and never
model-supplied).

**Manual / future path.** The published `@budgetary/mcp` implements the
`on-session-end` subcommand two ways: a host **hook** form (a JSON session-end
payload on stdin, used by Claude Code) and a **foreground** form that takes a
rollout/transcript file path directly. The runtime parser now recognizes the
Codex rollout `token_count` shape (cumulative `total_token_usage`, cache reads
excluded), so the foreground form closes the loop on Codex today:

```bash
# Real, transcript-derived counts from a Codex rollout — run from the project dir:
npx -y @budgetary/mcp on-session-end --transcript ~/.codex/sessions/rollout-<ts>-<uuid>.jsonl
```

It prints what it submitted, or exactly why it didn't; add `--failed` if the
task didn't complete. (Piping a raw rollout to stdin — `cat rollout | … on-session-end`
— does **not** work: stdin is the hook-payload channel, not a transcript, so a
raw rollout there is rejected with a pointer to the `--transcript` form.)

When Codex ships a real end-of-session plugin event, add a `hooks/hooks.json`
that runs the hook (stdin-payload) form — the handler already ships in the
published [`@budgetary/mcp`](https://www.npmjs.com/package/@budgetary/mcp) package
(source and tests under [`clients/mcp/`](../clients/mcp/)).

## Validate + local-test

There is no `claude plugin validate` analogue on the CLI; the arbiter is the
**Codex-bundled validator** that *"mirrors the workspace plugin ingestion
schema"*:

```bash
# Needs PyYAML (the validator parses SKILL.md frontmatter).
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  clients/codex
# expect: Plugin validation passed: .../clients/codex
```

Exercise the MCP `estimate` tool and the (manual) actuals path against the
published package:

```bash
# estimate tool is served over stdio:
BUDGETARY_API_KEY=bg_test_... npx -y @budgetary/mcp   # then speak MCP, or load via Codex

# actuals fail-closed on the hook (stdin) form — exit 0, nothing submitted:
printf ''         | npx -y @budgetary/mcp on-session-end ; echo $?   # -> 0 (silent)
printf 'not json' | npx -y @budgetary/mcp on-session-end ; echo $?   # -> 0 (prints a pointer to --transcript on stderr)

# foreground form reads a real rollout and reports what it did (or why it didn't):
npx -y @budgetary/mcp on-session-end --transcript ~/.codex/sessions/rollout-<ts>-<uuid>.jsonl
```

### Install <a id="install"></a>

Once this branch is on `main`, and on a CLI build that ships `codex plugin`:

```bash
codex plugin marketplace add thriftell/budgetary-clients
codex plugin add budgetary@budgetary
# then start a NEW Codex thread to pick up the skill + MCP tool
```

On a CLI build **without** the `codex plugin` subcommand (e.g. 0.40.0), install
from a local clone by pointing Codex at the repo-root marketplace:

```bash
git clone https://github.com/thriftell/budgetary-clients
# add the repo-root marketplace (.agents/plugins/marketplace.json) via the
# in-app plugin browser / codex plugin marketplace add <repo-root> on a CLI that
# supports it, then reinstall and start a new thread.
```

The marketplace name (`budgetary`) and the plugin name (`budgetary`) are both
`budgetary`, hence `budgetary@budgetary`.

## Submit to the official directory

OpenAI's official Codex **plugin directory** is **not self-serve** yet — there is
no public application form analogous to Claude Code's Console submission. The
curated marketplaces (e.g. `openai-curated` / "ChatGPT Official") are
OpenAI-managed.

- **State: deferred.** The self-hosted repo marketplace already ships from this
  repo (install works now from a local clone / a CLI that exposes `codex
  plugin`). File the directory submission when OpenAI opens a self-serve path,
  and record the outcome here.
- **Prereqs already satisfied:** a valid repo-root `.agents/plugins/marketplace.json`;
  a `plugin.json` that passes the bundled `validate_plugin.py`; an Apache-2.0
  `LICENSE`.
