# Budgetary for Codex

A [Codex CLI](https://github.com/openai/codex) plugin that adds:

- **An `estimate` skill** — get a pre-flight token-spend estimate before running a task.
- **A `Stop` hook** — after the turn finishes, submit realized token totals so future estimates calibrate.

It is the Codex twin of the `@budgetary/claude-code` plugin. Both plugins share `~/.budgetary/pending.json` and the same API-key resolution, so a user with both installed configures once.

## Install (development)

The plugin isn't yet published to a marketplace. For local development:

```bash
git clone https://github.com/rickyjs1955/budgetary-clients
cd budgetary-clients
pnpm install
pnpm --filter @budgetary/sdk build
pnpm --filter @budgetary/codex build
```

Then point Codex at the plugin directory. Codex auto-discovers plugins from `~/.codex/plugins/<name>/`, so symlink the built plugin in place:

```bash
mkdir -p ~/.codex/plugins
ln -s "$PWD/clients/codex" ~/.codex/plugins/budgetary
```

(Or whatever the current Codex install flow is on your version. Codex reads `.codex-plugin/plugin.json` and, as a compatibility alias, `.claude-plugin/plugin.json`.)

## Configure the API key

The plugin reads the API key from the same locations as the Claude Code plugin — so if you've already configured one, you don't have to do it again. In order:

1. `BUDGETARY_API_KEY` environment variable.
2. `~/.budgetary/config.json` → `{ "api_key": "bg_..." }`.

```bash
export BUDGETARY_API_KEY=bg_live_...

# or, persistently:
mkdir -p ~/.budgetary
echo '{ "api_key": "bg_live_..." }' > ~/.budgetary/config.json
```

If neither is set, the `estimate` skill prints a configure-your-key hint and short-circuits — it does not call the API and does not crash Codex. The API key never appears in `pending.json`, in stdout, or in any error message.

## Commands

The plugin ships one user-invocable skill:

> **`estimate`** — Ask for a Budgetary estimate of a task before running it. Invoke via Codex's `/skills` browser, by referencing the skill in your prompt, or implicitly (the model will pick it when you ask "how many tokens will it take to …").

Sample output:

```text
Estimated cost: 48,000 tokens (p10–p90: 12,500–220,000)
Scenario: confident   (confidence 0.74)
Model: claude-opus-4-7

Pending estimate stored. Run the task and Budgetary will record the actuals
when the session ends.
```

Out-of-domain queries return a void response:

```text
Budgetary cannot confidently estimate this query (out of domain).
No charge — proceed at your own risk.
```

## How telemetry works

When the `estimate` skill runs, the plugin appends a small entry to `~/.budgetary/pending.json`:

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

When the Codex turn ends (`Stop` hook), the bundled hook:

1. Reads the most recent pending entry.
2. Drops it silently if it's older than **24 hours**.
3. Parses the rollout transcript JSONL at `transcript_path` to total `tokens_in` and `tokens_out`.
4. Submits an actuals payload to Budgetary; on success removes the entry from the store; on failure leaves it and increments `attempts`.
5. After 5 failed attempts the entry is dropped and a single warning is logged to stderr.

If token totals cannot be extracted from the transcript the hook does nothing — submitting actuals without real token counts would corrupt calibration data.

## Privacy

Only these values cross the network, and only to `https://api.budgetary.tools`:

- The task description you pass to the `estimate` skill.
- A SHA-256 prefix of your working-directory absolute path (groups estimates by project; reveals nothing about the path).
- After the turn: `tokens_in`, `tokens_out`, `duration_ms`, and a `success` flag.

Nothing else leaves the machine. The API key is never logged.

## Troubleshooting

| Question | Answer |
|---|---|
| Where is the pending store? | `~/.budgetary/pending.json` |
| How do I clear it? | `rm ~/.budgetary/pending.json` (the plugin recreates an empty store on the next call). |
| The hook isn't firing. | Verify the plugin was discovered (`/plugins` in Codex). Check `hooks/hooks.json` is present and that `$PLUGIN_ROOT` resolves to the plugin install path. |
| The hook fires but no actuals submit. | Token totals couldn't be extracted from the rollout JSONL. See "How telemetry works" — the plugin no-ops rather than submit garbage. |
| The plugin says "no API key configured" even after I set `BUDGETARY_API_KEY`. | The hook subprocess inherits Codex's environment; make sure the variable is set in the shell that launched Codex, not just the current shell. |

## Reference

For the v1 API contract — endpoints, error codes, scenario labels — see [docs/api-contract.md](../../docs/api-contract.md).

Licensed under [Apache-2.0](../../LICENSE).
