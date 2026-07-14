# Budgetary for Codex

A [Codex](https://developers.openai.com/codex) plugin that adds:

- **An `estimate` tool** (and an `estimate` skill that calls it) — a pre-flight, probabilistic token-spend estimate for a coding task: a token range (p10–p90), a scenario label, and a confidence score.

It is the Codex twin of the [`budgetary` Claude Code plugin](../claude-code/README.md). Both share `~/.budgetary/pending.json` and the same API-key resolution, so a user with both installed configures once.

Everything executable runs through the published [`@budgetary/mcp`](https://www.npmjs.com/package/@budgetary/mcp) package via `npx`, so the plugin needs no build artifacts: Codex loads only the manifests (`plugin.json`, `.mcp.json`, the skill), and there is no `dist/` or `node_modules` to build or bundle at install time. (The runtime — the `estimate` tool and the `on-session-end` handler — lives in the published `@budgetary/mcp` package; its source and tests are under [`clients/mcp/`](../mcp/) in this monorepo — see [Actuals](#actuals) below.)

## Install

This plugin ships from the repo-root marketplace catalog at [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json). Add the marketplace and install the plugin:

```bash
codex plugin marketplace add thriftell/budgetary-clients
codex plugin add budgetary@budgetary
```

The marketplace name (`budgetary`) and the plugin name (`budgetary`) are both `budgetary`, hence `budgetary@budgetary`. Start a **new Codex thread** afterward so the new skill and MCP tool are picked up.

> **Codex CLI version note.** The `codex plugin …` management commands are part of Codex's plugin system but are **not exposed on every CLI build** (they are absent on the `codex-cli 0.40.0` used to verify this plugin). If `codex plugin` is unavailable, install from a local clone instead — see [the runbook](../../docs/codex-plugin-runbook.md#install).

> The plugin shells out to `npx -y @budgetary/mcp`, so Node.js and npm must be available on your `PATH` (the same requirement as any npx-launched MCP server). The package is downloaded and cached on first use.

## Configure the API key

Codex plugins do not have an install-time secret prompt (the `plugin.json` manifest has no user-config field — that field is rejected by Codex plugin validation). The bundled `budgetary` MCP server therefore resolves the key from the environment, in order:

1. the `BUDGETARY_API_KEY` environment variable (set in the shell that launched Codex — the MCP server inherits it), or
2. `~/.budgetary/config.json` → `{ "api_key": "bg_..." }`.

```bash
export BUDGETARY_API_KEY=bg_test_...

# or, persistently (recommended for Codex, independent of the launching shell):
mkdir -p ~/.budgetary
# Write the key with an EDITOR so it never lands in your shell history:
"${EDITOR:-nano}" ~/.budgetary/config.json   # add: { "api_key": "bg_test_..." }
chmod 600 ~/.budgetary/config.json            # owner-only
```

> Avoid `echo '{ "api_key": "bg_test_..." }' > ~/.budgetary/config.json` — that records the secret in your shell history. Use an editor (above), and `chmod 600` the file so it isn't world-readable.

A **`bg_test_`** key is the free testing tier and works immediately; **`bg_live_`** is the production key (and must be on an active plan).

If no key is configured, the `estimate` tool returns a short configure-your-key hint instead of an estimate — it never calls the API and never crashes Codex. The API key never appears in `pending.json`, in stdout, or in any error message.

## Commands

The plugin ships one skill, `estimate`, which calls the `estimate` MCP tool. Invoke it through Codex's skill browser, by referencing the skill in your prompt, or implicitly (the model will pick it when you ask "how many tokens will it take to …").

Sample output:

```text
Estimated cost: ~48,000 tokens (range 12,500–220,000, p10–p90)
Scenario: confident — well-supported, the range is reliable.
Confidence: 0.74 (moderate)
Model: gpt-5.4

Pending estimate stored.
```

A low-confidence estimate leads with the range and a caution instead of a precise-looking number:

```text
Estimated range: 12,500–220,000 tokens (p10–p90), midpoint ~48,000
⚠ Wide range — treat the midpoint as a rough guess, not a number to rely on.
Scenario: uncertain — supported, but the range is wide.
Confidence: 0.35 (low)
```

Out-of-domain queries return a void response:

```text
Budgetary cannot confidently estimate this query (out of domain).
This estimate wasn't billed. Proceed without a prediction — at your own judgment.
```

## How telemetry works

When the `estimate` tool runs, the MCP server appends a small entry to `~/.budgetary/pending.json`:

```json
{
  "version": 1,
  "entries": [
    {
      "estimate_id": "est_01H...",
      "query": "refactor the payments module ...",
      "project_id": "<sha256-prefix-of-cwd>",
      "created_at": "2026-05-27T10:14:00Z",
      "attempts": 0
    }
  ]
}
```

The estimate tool is the **only** model-invokable surface. There is deliberately no tool or code path that lets a model report token usage — realized token counts are only ever derived from a real session transcript (see below), never from a number a model supplies.

## Actuals

The Claude Code plugin closes the predicted-vs-actual loop **automatically** with a `SessionEnd` hook that submits the **real**, transcript-derived token totals when a session ends. **Codex does not ship an equivalent plugin hook**, so on Codex the loop is closed **manually** (one command after the session) rather than automatically:

- Codex's plugin model bundles **skills, MCP servers, and apps** — not hooks. Codex's plugin manifest **validation rejects a `hooks` field**, the plugin scaffolder does not wire any lifecycle events, and the `codex-cli 0.40.0` binary exposes no plugin session-end / stop event. (The published docs at `developers.openai.com/codex/plugins/build` list `SessionStart`/`SessionEnd`, but the shipping CLI and the official validator do not honor them — verified 2026-06-12. See [the runbook](../../docs/codex-plugin-runbook.md).)
- We deliberately **do not ship a `SessionEnd`/`Stop` hook**, because a hook that the host never fires would be dead weight and an empty promise — and fabricating a token count is never acceptable.

**Submit actuals after a session** by pointing the published package at that session's rollout file:

```bash
# Real, transcript-derived counts from a Codex rollout (JSONL):
npx -y @budgetary/mcp on-session-end --transcript ~/.codex/sessions/rollout-<ts>-<uuid>.jsonl
```

Run it from the **same directory you estimated in** — the estimate is bound to that project. The command parses the rollout's cumulative `token_count` events, submits only real counts (cache reads excluded, `input_tokens − cached_input_tokens`), and prints what it submitted — or exactly why it didn't (no API key, no pending estimate for this project, or a file it couldn't read). The run is recorded as **successful** by default; add `--failed` if the task didn't complete.

> If you have no rollout to point at, `npx -y @budgetary/mcp report-actual` prompts you for the counts by hand instead.

When Codex exposes a real end-of-session plugin event, wiring this up automatically is a one-line addition — a `hooks/hooks.json` running the same `npx -y @budgetary/mcp on-session-end` handler the Claude Code plugin already uses. That handler ships in the published [`@budgetary/mcp`](https://www.npmjs.com/package/@budgetary/mcp) package (source and tests under [`clients/mcp/`](../mcp/)), ready for the day the event lands.

## Privacy

Only these values cross the network, and only to `https://api.budgetary.tools`:

- The task description you pass to the `estimate` skill.
- A SHA-256 prefix of your working-directory absolute path (groups estimates by project; reveals nothing about the path).
- If you submit actuals manually: `tokens_in`, `tokens_out`, `duration_ms`, a `success` flag, and a constant **client label** (the fixed string `mcp_client`, saying which client sent the row — derived from no part of you, your machine, or your task; operators running an automated harness can override it with `BUDGETARY_SOURCE`, which is a label only and changes nothing about how the data is treated).

Nothing else leaves the machine. The API key is never logged.

## Troubleshooting

| Question | Answer |
|---|---|
| Where is the pending store? | `~/.budgetary/pending.json` |
| How do I clear it? | `rm ~/.budgetary/pending.json` (the store is recreated on the next call). |
| The estimate tool isn't available. | Confirm `npx -y @budgetary/mcp` runs in your shell, that the `budgetary` MCP server loaded (start a fresh Codex thread after install), and that an API key is configured. |
| The plugin shows "failed to load". | Validate it with the bundled Codex plugin validator (`plugin-creator` skill → `validate_plugin.py`). Only `plugin.json` may live under `.codex-plugin/`; `skills/` and `.mcp.json` are at the plugin root. A `hooks` field in `plugin.json` is **rejected** — this plugin declares none. |
| The plugin says "no API key configured". | Set `BUDGETARY_API_KEY` in the shell that launches Codex, or write `~/.budgetary/config.json`. |
| Does it submit actuals automatically? | Not on Codex yet — see [Actuals](#actuals). Close the loop manually after a session with `npx -y @budgetary/mcp on-session-end --transcript <rollout>` (or `report-actual`). |

## Submitting to the official directory

The repo-root [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json) makes this plugin installable directly from this repository. Listing it in OpenAI's official Codex plugin directory is **not yet self-serve** and is deferred; see the runbook: [docs/codex-plugin-runbook.md](../../docs/codex-plugin-runbook.md).

## Reference

For the v1 API contract — endpoints, error codes, scenario labels — see [docs/api-contract.md](../../docs/api-contract.md).

Licensed under [Apache-2.0](../../LICENSE).
