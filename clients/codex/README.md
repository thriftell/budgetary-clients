# Budgetary for Codex

A [Codex](https://developers.openai.com/codex) plugin that adds:

- **An `estimate` tool** (and an `estimate` skill that calls it) — a pre-flight, probabilistic token-spend estimate for a coding task: a token range (p10–p90), a scenario label, and a confidence score.

It is the Codex twin of the [`budgetary` Claude Code plugin](../claude-code/README.md). Both share `~/.budgetary/pending.json` and the same API-key resolution, so a user with both installed configures once.

Everything executable runs through the published [`@budgetary/mcp`](https://www.npmjs.com/package/@budgetary/mcp) package via `npx`, so the plugin needs no build artifacts: Codex loads only the manifests (`plugin.json`, `.mcp.json`, the skill), and there is no `dist/` or `node_modules` to build or bundle at install time. (The TypeScript under `src/` is the package's tested reference implementation; it is not on the plugin's runtime path — see [Actuals](#actuals-deferred) below.)

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
export BUDGETARY_API_KEY=bg_live_...

# or, persistently (recommended for Codex, independent of the launching shell):
mkdir -p ~/.budgetary
echo '{ "api_key": "bg_live_..." }' > ~/.budgetary/config.json
```

If no key is configured, the `estimate` tool returns a short configure-your-key hint instead of an estimate — it never calls the API and never crashes Codex. The API key never appears in `pending.json`, in stdout, or in any error message.

## Commands

The plugin ships one skill, `estimate`, which calls the `estimate` MCP tool. Invoke it through Codex's skill browser, by referencing the skill in your prompt, or implicitly (the model will pick it when you ask "how many tokens will it take to …").

Sample output:

```text
Estimated cost: 48,000 tokens (p10–p90: 12,500–220,000)
Scenario: confident   (confidence 0.74)
Model: gpt-5.4

Pending estimate stored.
```

Out-of-domain queries return a void response:

```text
Budgetary cannot confidently estimate this query (out of domain).
No charge — proceed at your own risk.
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

## Actuals (deferred)

The Claude Code plugin closes the predicted-vs-actual loop with a `SessionEnd` hook that submits the **real**, transcript-derived token totals when a session ends. **Codex does not ship an equivalent plugin hook**, so this plugin is **estimate-only** today:

- Codex's plugin model bundles **skills, MCP servers, and apps** — not hooks. Codex's plugin manifest **validation rejects a `hooks` field**, the plugin scaffolder does not wire any lifecycle events, and the `codex-cli 0.40.0` binary exposes no plugin session-end / stop event. (The published docs at `developers.openai.com/codex/plugins/build` list `SessionStart`/`SessionEnd`, but the shipping CLI and the official validator do not honor them — verified 2026-06-12. See [the runbook](../../docs/codex-plugin-runbook.md).)
- We deliberately **do not ship a `SessionEnd`/`Stop` hook**, because a hook that the host never fires would be dead weight and an empty promise — and fabricating a token count is never acceptable.

When Codex exposes a real end-of-session plugin event, wiring actuals is a one-line addition: a `hooks/hooks.json` running `npx -y @budgetary/mcp on-session-end` (the published package already implements that subcommand — it reads the session transcript, totals `(tokens_in − cache_read) + tokens_out`, and submits real counts, failing closed if it can't). The reference implementation of that handler lives under [`src/hooks/on_session_end.ts`](src/hooks/on_session_end.ts) and is exercised by CI, ready for the day the event lands.

In the meantime, you can submit actuals **manually** after a session:

```bash
# Pipe a Codex rollout transcript (JSONL) to the published package:
cat ~/.codex/sessions/rollout-<ts>-<uuid>.jsonl | npx -y @budgetary/mcp on-session-end
```

This submits only real, transcript-derived counts (cache reads excluded); if the transcript yields no token totals it submits nothing and exits cleanly.

## Privacy

Only these values cross the network, and only to `https://api.budgetary.tools`:

- The task description you pass to the `estimate` skill.
- A SHA-256 prefix of your working-directory absolute path (groups estimates by project; reveals nothing about the path).
- If you submit actuals manually: `tokens_in`, `tokens_out`, `duration_ms`, and a `success` flag.

Nothing else leaves the machine. The API key is never logged.

## Troubleshooting

| Question | Answer |
|---|---|
| Where is the pending store? | `~/.budgetary/pending.json` |
| How do I clear it? | `rm ~/.budgetary/pending.json` (the store is recreated on the next call). |
| The estimate tool isn't available. | Confirm `npx -y @budgetary/mcp` runs in your shell, that the `budgetary` MCP server loaded (start a fresh Codex thread after install), and that an API key is configured. |
| The plugin shows "failed to load". | Validate it with the bundled Codex plugin validator (`plugin-creator` skill → `validate_plugin.py`). Only `plugin.json` may live under `.codex-plugin/`; `skills/` and `.mcp.json` are at the plugin root. A `hooks` field in `plugin.json` is **rejected** — this plugin declares none. |
| The plugin says "no API key configured". | Set `BUDGETARY_API_KEY` in the shell that launches Codex, or write `~/.budgetary/config.json`. |
| Does it submit actuals automatically? | Not on Codex yet — see [Actuals](#actuals-deferred). Use the manual `on-session-end` command above. |

## Submitting to the official directory

The repo-root [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json) makes this plugin installable directly from this repository. Listing it in OpenAI's official Codex plugin directory is **not yet self-serve** and is deferred; see the runbook: [docs/codex-plugin-runbook.md](../../docs/codex-plugin-runbook.md).

## Reference

For the v1 API contract — endpoints, error codes, scenario labels — see [docs/api-contract.md](../../docs/api-contract.md).

Licensed under [Apache-2.0](../../LICENSE).
