# Budgetary for Claude Code

A [Claude Code](https://claude.com/claude-code) plugin that adds:

- **An `estimate` tool** (and a `/estimate <task>` slash command) — a pre-flight, probabilistic token-spend estimate for a coding task: a token range (p10–p90), a scenario label, and a confidence score.
- **A session-end hook** — after the session finishes, it submits the realized token totals so future estimates calibrate.

Together they close the predicted-vs-actual loop on this host. Without the hook the API has no feedback signal.

Everything executable runs through the published [`@budgetary/mcp`](https://www.npmjs.com/package/@budgetary/mcp) package via `npx`, so the plugin needs no build artifacts: Claude Code loads only the manifests (`plugin.json`, `.mcp.json`, `hooks/hooks.json`, the skill), and there is no `dist/` or `node_modules` to build or bundle at install time. (The TypeScript under `src/` is the package's tested reference implementation; it is not on the plugin's runtime path.)

## Install

```text
/plugin marketplace add thriftell/budgetary-clients
/plugin install budgetary@budgetary
```

Claude Code prompts for your Budgetary API key during install (the value is masked and stored in your system keychain). Then activate it in the running session:

```text
/reload-plugins
```

Non-interactive / scripted equivalent:

```bash
claude plugin marketplace add thriftell/budgetary-clients
claude plugin install budgetary@budgetary --config api_key=bg_live_...
```

> The plugin shells out to `npx -y @budgetary/mcp`, so Node.js and npm must be available on your `PATH` (the same requirement as any npx-launched MCP server). The package is downloaded and cached on first use.

## Configure the API key

The install-time prompt — the `api_key` user-config option declared in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) — is the simplest path. The value is masked, stored in your system keychain, and injected into both the estimate tool and the session-end hook.

You can instead (or additionally) provide the key via:

1. the `BUDGETARY_API_KEY` environment variable (set in the shell that launched Claude Code), or
2. `~/.budgetary/config.json` → `{ "api_key": "bg_..." }`.

If no key is configured, `/estimate` prints a configure-your-key hint and the session-end hook quietly does nothing — it never calls the API and never crashes the session. The API key never appears in `pending.json`, in stdout, or in any error message.

## Commands

### `/estimate <task description>`

```text
/estimate refactor the payments module to remove the legacy webhook handler

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

The slash command and the model-invokable `estimate` tool are the same path: both call the Budgetary API, print the estimate verbatim, and append a pending entry to `~/.budgetary/pending.json`.

## How telemetry works

When an estimate is produced, the `estimate` tool appends a small entry to `~/.budgetary/pending.json`:

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

When the Claude Code session ends, the bundled hook runs `npx -y @budgetary/mcp on-session-end` (the same `@budgetary/mcp` package, invoked with the session payload on stdin). It:

1. Reads the most recent pending entry.
2. Drops it silently if it's older than **24 hours**.
3. Parses the session transcript and totals `tokens_in + tokens_out` across all model calls. **Cached reads (`cache_read_input_tokens`) are excluded** — folding them back in would inflate realized spend and corrupt calibration.
4. Submits an actuals payload to Budgetary; on success removes the entry; on failure leaves it and increments `attempts`.
5. After 5 failed attempts the entry is dropped and a single warning is logged to stderr.

The hook submits **only real, transcript-derived token counts** — never a model-supplied number. If the transcript yields no token totals, or the payload can't be parsed, the hook submits nothing and exits cleanly. There is deliberately no tool or code path that lets a model report token usage.

## Privacy

Only these values cross the network, and only to `https://api.budgetary.tools`:

- The task description you pass to `/estimate`.
- A SHA-256 prefix of your working-directory absolute path (groups estimates by project; reveals nothing about the path).
- After the session: `tokens_in`, `tokens_out`, `duration_ms`, and a `success` flag.

Nothing else leaves the machine. The API key is never logged.

## Troubleshooting

| Question | Answer |
|---|---|
| Where is the pending store? | `~/.budgetary/pending.json` |
| How do I clear it? | `rm ~/.budgetary/pending.json` (the plugin recreates an empty store on the next call). |
| The plugin shows "failed to load". | Run `claude plugin validate ./clients/claude-code` (or check the `/plugin` **Errors** tab). Only `plugin.json` may live under `.claude-plugin/`; `hooks/`, `skills/`, and `.mcp.json` are auto-loaded from the plugin root and must **not** also be declared in `plugin.json`. |
| The estimate tool isn't available. | Confirm `npx -y @budgetary/mcp` runs in your shell, and that the `budgetary` MCP server is listed in `claude plugin details budgetary`. |
| The hook fires but no actuals submit. | Either the transcript yielded no token totals (the hook no-ops rather than submit garbage) or no API key is configured for the hook subprocess. |
| The plugin says "no API key configured". | Set it via the install prompt (`/plugin configure budgetary@budgetary`), `BUDGETARY_API_KEY`, or `~/.budgetary/config.json`. |

## Submitting to the community marketplace

The repo-root [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) makes this plugin installable directly from this repository. To list it in Anthropic's community plugin directory for discovery, see the runbook: [docs/claude-code-plugin-runbook.md](../../docs/claude-code-plugin-runbook.md).

## Reference

For the v1 API contract — endpoints, error codes, scenario labels — see [docs/api-contract.md](../../docs/api-contract.md).

Licensed under [Apache-2.0](../../LICENSE).
