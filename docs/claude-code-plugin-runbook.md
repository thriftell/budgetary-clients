# Runbook — Claude Code plugin marketplace & community submission

This is the procedure for distributing the **Budgetary** Claude Code plugin: the
self-hosted marketplace that ships from this repository, and the submission to
Anthropic's **community** plugin directory (`anthropics/claude-plugins-community`)
for discovery.

> **Scope.** This covers the Claude Code plugin (0014b-2) only. The MCP registry
> listing (0014b-1) and the Codex marketplace (0014b-3) are separate work, covered
> in [`mcp-registry-runbook.md`](./mcp-registry-runbook.md) and a later runbook.

> **Re-verify before relying on this.** The plugin/marketplace system is GA but
> moves across CLI versions. The facts below were verified against
> `code.claude.com/docs` and `claude` CLI **v2.1.170** on 2026-06-12. Re-check the
> schema and the submission entry points before each submission.

---

## What's already in the repo

- [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) — the
  repo-root marketplace catalog. One plugin entry, `source: ./clients/claude-code/`.
- [`clients/claude-code/.claude-plugin/plugin.json`](../clients/claude-code/.claude-plugin/plugin.json)
  — the plugin manifest: metadata + a `userConfig` `api_key` option. **No**
  `skills`/`hooks`/`mcpServers` fields (those auto-load from the standard locations
  below — declaring them double-loads and fails the plugin).
- [`clients/claude-code/.mcp.json`](../clients/claude-code/.mcp.json) — the MCP
  server (`npx -y @budgetary/mcp`), auto-loaded, with `BUDGETARY_API_KEY:
  ${user_config.api_key}`.
- [`clients/claude-code/hooks/hooks.json`](../clients/claude-code/hooks/hooks.json)
  — the `SessionEnd` hook: `npx -y @budgetary/mcp on-session-end`.
- [`clients/claude-code/skills/estimate/SKILL.md`](../clients/claude-code/skills/estimate/SKILL.md)
  — the `/estimate` slash command (delegates to the MCP `estimate` tool).

The plugin carries no build artifacts: everything executable runs from the
published [`@budgetary/mcp`](https://www.npmjs.com/package/@budgetary/mcp) npm
package via `npx`, so a git-cloned/copied install works without `dist/` or
`node_modules/`.

## Layout rules that the validator does NOT catch

`claude plugin validate` is a **static schema** check. It passed on manifests that
then **failed to load at runtime**. The rules that matter:

- **Only `plugin.json` belongs under `.claude-plugin/`.** `hooks/`, `skills/`, and
  `.mcp.json` live at the **plugin root** and are **auto-loaded**.
- **Do not re-declare an auto-loaded component in `plugin.json`.** Declaring
  `"hooks": "./hooks/hooks.json"` triggers `Duplicate hooks file detected` and the
  whole plugin fails to load. Same risk for `skills`.
- **The MCP server must be a `.mcp.json` file, not inline `mcpServers` in
  `plugin.json`** — on CLI v2.1.170, an inline `mcpServers` object was not
  registered (`claude plugin details` showed `MCP servers (0)`); the auto-loaded
  `.mcp.json` registered correctly (`MCP servers (1)`).

Always confirm with a real install, not just `validate` (see below).

## Validate + local-test

From the repo root:

```bash
# Static schema checks (run --strict in CI)
claude plugin validate ./clients/claude-code --strict   # the plugin manifest
claude plugin validate .                  --strict       # the marketplace manifest

# Real install (the load test validate cannot do). Use --scope local so it lands
# in .claude/settings.local.json (gitignored), not your user settings.
claude plugin marketplace add "$(pwd)"
claude plugin install budgetary@budgetary --scope local --config api_key=bg_test_...
claude plugin list                         # expect: budgetary@budgetary  ✔ enabled
claude plugin details budgetary            # expect: Skills (1), Hooks (1), MCP servers (1)

# Clean up
claude plugin uninstall budgetary --scope local
claude plugin marketplace remove budgetary
```

A green run means: the plugin **loads** (not just validates), the `estimate` tool
and the `SessionEnd` hook are present, and the `api_key` user-config option is
accepted.

To exercise the hook's real/fail-closed behavior directly:

```bash
# Real counts submitted (cache_read excluded) — point base_url at a mock and POST /v1/actuals.
# Fails closed — bad stdin / missing transcript / no key => exit 0, nothing submitted:
printf 'not json'              | npx -y @budgetary/mcp on-session-end ; echo $?   # -> 0
printf '{"reason":"clear"}'    | npx -y @budgetary/mcp on-session-end ; echo $?   # -> 0
```

## End-user install (once this branch is on `main`)

```text
/plugin marketplace add thriftell/budgetary-clients
/plugin install budgetary@budgetary
/reload-plugins
```

Claude Code prompts for the `api_key` at install (masked, stored in the system
keychain). The marketplace name (`budgetary`) and the plugin name (`budgetary`)
are both `budgetary`, hence `budgetary@budgetary`.

## Submit to the community marketplace

Submission is via an **in-app web form**, not a GitHub PR — PRs opened against
`anthropics/claude-plugins-community` are auto-closed (the repo is a read-only
nightly mirror of Anthropic's review pipeline).

1. **Prereqs (all already satisfied by this repo):** a valid
   `.claude-plugin/marketplace.json` at the repo root; each plugin has a valid
   `plugin.json`; `claude plugin validate` passes; a `LICENSE` is present
   (Apache-2.0).
2. **Submit.** Pick one entry point — both feed the same pipeline:
   - **Individual developer (no org required):** the Console form at
     <https://platform.claude.com/plugins/submit>. Provide the repo URL
     (`https://github.com/thriftell/budgetary-clients`), plugin name (`budgetary`),
     description, and category.
   - **Team/Enterprise org member:** <https://claude.ai/admin-settings/directory/submissions/plugins/new>
     (requires a Team/Enterprise org + directory-management access).
   - Shortcut: <https://clau.de/plugin-directory-submission> redirects to the docs
     section that links both forms.
3. **Review is async and gated.** The pipeline runs `claude plugin validate` plus
   automated safety/security screening. On approval the plugin is **pinned to a
   commit SHA** in the community catalog, and CI advances the pin as you push new
   commits. The public catalog syncs **nightly**, so there's a delay between
   approval and installability.
4. **Once live**, users install with:
   ```text
   /plugin marketplace add anthropics/claude-plugins-community
   /plugin install budgetary@claude-community
   ```
   (Note: the marketplace is *added* as `anthropics/claude-plugins-community` but
   *installed from* as `@claude-community`.)

### Submission status

- **Eligibility:** OK — the Console form accepts individual developers; no org is
  required. This repo meets the source-repo prerequisites today.
- **State:** **ready to file.** The self-hosted marketplace already ships from this
  repo (one-command install works now). The community-directory submission is a
  review-gated, async, human-initiated web-form step — file it from
  <https://platform.claude.com/plugins/submit> and record the outcome here when it
  lands. The official `claude-plugins-official` marketplace is curated by Anthropic
  with **no** application process; this submission targets the **community**
  directory only.

> **Caveat:** the Console submit form is a client-rendered app whose exact field
> labels could not be scraped ahead of time; the field list above is derived from
> the marketplace.json schema the pipeline consumes. Treat labels as best-effort;
> the flow itself is doc-confirmed.
