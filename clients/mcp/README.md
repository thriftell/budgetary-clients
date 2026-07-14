# @budgetary/mcp

A single [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP-capable host — Claude Code, Cursor, GitHub Copilot, Codex, and others — a pre-flight, probabilistic **token-spend estimate** for a coding task before you run it, and a best-effort, never-fabricated way to record what the task actually cost. Build it once; add it everywhere. It replaces the previously-planned per-host extensions.

The server exposes exactly one model-invokable tool, `estimate`. It talks to the hosted Budgetary API at `https://api.budgetary.tools`.

## Install — one command per host

Pass your key as `BUDGETARY_API_KEY` and tag the host with `BUDGETARY_HOST` so ledger entries distinguish where the estimate came from. Always include `-y` with `npx` so the launch never blocks on an install prompt.

### Claude Code

```bash
claude mcp add budgetary \
  --env BUDGETARY_API_KEY=bg_test_... \
  --env BUDGETARY_HOST=claude-code \
  -- npx -y @budgetary/mcp
```

> **Automatic actuals need the plugin, not just this command.** `claude mcp add` wires the **estimate tool** only. The session-end hook that submits real actuals is wired by the bundled [Claude Code plugin](../claude-code/README.md) (via its manifest), so with a bare `claude mcp add` you get estimates but record actuals **manually** (`npx @budgetary/mcp report-actual`), the same as any other host. Install the plugin for the automatic loop.

### Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "budgetary": {
      "command": "npx",
      "args": ["-y", "@budgetary/mcp"],
      "env": {
        "BUDGETARY_API_KEY": "bg_test_...",
        "BUDGETARY_HOST": "cursor"
      }
    }
  }
}
```

### GitHub Copilot (VS Code) — `.vscode/mcp.json`

VS Code uses the `servers` key (not `mcpServers`) and can prompt for secrets via `inputs`:

```json
{
  "inputs": [
    { "id": "budgetary-key", "type": "promptString", "description": "Budgetary API key", "password": true }
  ],
  "servers": {
    "budgetary": {
      "command": "npx",
      "args": ["-y", "@budgetary/mcp"],
      "env": {
        "BUDGETARY_API_KEY": "${input:budgetary-key}",
        "BUDGETARY_HOST": "copilot"
      }
    }
  }
}
```

### Codex

```bash
codex mcp add budgetary \
  --env BUDGETARY_API_KEY=bg_test_... \
  --env BUDGETARY_HOST=codex \
  -- npx -y @budgetary/mcp
```

…or in `~/.codex/config.toml`:

```toml
[mcp_servers.budgetary]
command = "npx"
args = ["-y", "@budgetary/mcp"]

[mcp_servers.budgetary.env]
BUDGETARY_API_KEY = "bg_test_..."
BUDGETARY_HOST = "codex"
```

## API key setup

The server resolves the key in this order:

1. `BUDGETARY_API_KEY` in the server's environment (set via the host config above).
2. `~/.budgetary/config.json` → `{ "api_key": "bg_...", "base_url"? }`.

If neither is set, the `estimate` tool returns short configure-your-key guidance instead of an error — it never throws and never crashes the host.

```bash
mkdir -p ~/.budgetary
# Write the key with an EDITOR so it never lands in your shell history:
"${EDITOR:-nano}" ~/.budgetary/config.json   # add: { "api_key": "bg_test_..." }
chmod 600 ~/.budgetary/config.json            # owner-only
```

> Prefer an editor over `echo '{...}' > config.json`, which records the secret in your shell history, and `chmod 600` the file so it isn't world-readable.

Key prefixes denote the environment:

- **`bg_test_`** — the free testing tier. Works immediately for development.
- **`bg_live_`** — production. A live key must be on an **active plan**; if it isn't, the API returns **403** and the tool says *"Your Budgetary key isn't on an active plan."* (This is distinct from a **401**, which means the key itself was rejected.)

The API key never appears in a tool result, in `pending.json`, or in any log line.

## Optional: tag the language you're working in

You can optionally tag each estimate with the language you're working in, so your estimate history is grouped by language. Set it in the server's environment:

```
--env BUDGETARY_LANGUAGE=TypeScript
```

or add a `language` field to `~/.budgetary/config.json` (the environment variable wins if both are set):

```json
{ "api_key": "bg_test_...", "language": "TypeScript" }
```

It's a free-form display name — `TypeScript`, `Python`, `Go`, and so on — that the server tidies up; you don't need an exact spelling. Like `BUDGETARY_HOST`, it is a benign tag you **declare** in the environment: the language model never sets it and it is never guessed from your task description. There is intentionally no `language` argument on the `estimate` tool. If you set nothing, the estimate is simply recorded without a language — it's never required, and it never changes the estimate itself.

A plain stdio MCP server only sees the messages your host sends it, not which file you have open, so this declared value (one per host/session) is the signal it can rely on. Hosts that expose no language at all just record the estimate without one.

## Optional: `BUDGETARY_SOURCE` — an operator's label for a batch of runs

**Ordinary users have nothing to set here, and nothing changes if you don't.** This exists for operators who drive this client from an automated harness (a benchmark, a load test, a scripted evaluation) and want those runs labelled so they can tell them apart from real ones afterwards.

Set it **in the environment of the process you launch for that batch**, so its lifetime is the batch:

```bash
BUDGETARY_SOURCE=my-harness-run <the command your harness runs>
```

> **Do not put this one in your MCP host config.** Unlike `BUDGETARY_HOST` and `BUDGETARY_LANGUAGE`, this label should *not* go in `claude mcp add --env`, `~/.claude.json`, `.mcp.json`, or `~/.budgetary/config.json`. Those are **machine-wide and permanent**: a label you set there for one batch silently outlives it, and every ordinary session on that machine is labelled with it afterwards — undetectably, because the rows still look perfectly normal. `~/.budgetary/config.json` is not even read for this variable, on purpose. A label that describes *a run* should not outlive the run.

Each actuals submission carries this label. It defaults to `mcp_client`. It is an **opaque string** — the client attaches no meaning to it, validates only its shape (up to 64 characters of `A–Z a–z 0–9 . _ -`), and ignores anything malformed, falling back to the default rather than failing your submission. (Run with `BUDGETARY_DEBUG=1` to have it say so on stderr when it rejects a label; otherwise a typo is silent.)

Two things it is deliberately **not**:

- **It does not change how your data is treated.** It is a label, not a setting. Setting it (or not) grants nothing, unlocks nothing, and alters nothing about what is recorded or how it is used.
- **It is not a per-task field, and the model never sets it.** Like `BUDGETARY_HOST` and `BUDGETARY_LANGUAGE`, it is **declared** in the environment. There is intentionally no `source` argument on the `estimate` tool.

The label is resolved once, when the estimate is made, and stored on that estimate's pending entry — so if a submission has to be retried later (from a different session, with a different environment), it still reports the label of the run that actually happened.

## Actuals — automatic where possible, manual otherwise, never fabricated

A pre-flight estimate is only half the loop; calibration needs the **realized** token counts after the run. How those are recorded depends on what the host exposes:

- **Claude Code (with the plugin) — automatic.** This host writes a real session transcript. The plugin's session-end hook reads the true `tokens_in + tokens_out` (cache-read tokens **excluded**) and submits them — together with a short **behavior trace**: which tools the run used (`Read`, `Edit`, `Bash`, …), roughly how many tokens each, and two raw measurements per step — *which command it ran* (a **redacted** descriptor: a common program name such as `pytest` or `go test`, plus a **salted, non-reversible** digest of the rest — never a raw path, argument, or command) and *whether it succeeded*. The trace is measured from the transcript, never model-supplied, and any field that can't be read reliably is simply omitted; the total still submits. No human action needed. (A bare `claude mcp add` **without** the plugin has no session-end hook, so it is manual like the hosts below.)
- **Codex — manual, from the rollout.** Codex ships no session-end hook, but it writes a rollout transcript. After a session, submit its real counts:

  ```bash
  npx @budgetary/mcp on-session-end --transcript ~/.codex/sessions/rollout-<ts>-<uuid>.jsonl
  ```

  Run it from the directory you estimated in. Add `--failed` if the task didn't complete.
- **Cursor / Copilot / other hosts — manual.** These hosts do **not** hand a third-party server the token totals of a completed agent run, and the language model does not know them either. So you record them yourself when you have a moment:

  ```bash
  npx @budgetary/mcp report-actual
  ```

  It shows this project's most recent pending estimate and prompts you for the input/output token counts (read them from your host's usage UI, grouped numbers like `48,000` are fine), whether the task succeeded, and an optional duration.

To see which estimates still await actuals at any time (read-only, no server call):

```bash
npx @budgetary/mcp pending
```

> **The model never supplies token counts.** The only model-invokable tool is `estimate`. Actuals are submitted only from (a) the session-end hook reading a real transcript, or (b) the human-entered `report-actual` command. A fabricated actual would poison calibration, so there is deliberately no tool a model can call to write counts.

## Dashboard

For the predicted-vs-actual calibration dashboard, install **Budgetary** (`budgetary.budgetary-vscode`) from [Open VSX](https://open-vsx.org) — it runs in Cursor and other VS Code forks unchanged. This server does not re-implement it.

## Privacy

Only these things leave your machine, and only to `https://api.budgetary.tools`:

- The **task description** you pass to `estimate`.
- If you set it, the **language tag** you declared (e.g. `TypeScript`) — a benign label, the same kind of thing as the host name. Never sent unless you opt in via `BUDGETARY_LANGUAGE` or the config `language` field.
- After a run, the **token counts** (`tokens_in`, `tokens_out`), a `success` flag, and a duration.
- A constant **client label** — `mcp_client` unless an operator overrode it with `BUDGETARY_SOURCE` (see above). It says which client sent the row and nothing else: it is a fixed string, derived from no part of you, your machine, or your task.
- On Claude Code, a **behavior trace**: per step, the host tool name (e.g. `Read`, `Bash`), its token count, a **redacted descriptor** of what it acted on, and whether it succeeded. The descriptor exposes a program name *in the clear only when it is a common, non-sensitive tool* (e.g. `pytest`, `npm run`) — a pasted credential or a private script name is never shown, only its **salted digest**; everything after the program (paths, arguments, the rest of the command) always lives inside the digest, or a bare path digest for a file tool. Custom/internal tool names (e.g. an org's private MCP tool) are reported generically as `mcp:other`, never verbatim. **No file contents, absolute paths, command arguments, or output ever leave the machine** — only an allowlisted program name and an opaque key. Set `BUDGETARY_TRACE_TARGET=off` to drop the descriptor entirely (the trace falls back to tool names + token counts); any value other than an explicit `1`/`true`/`on`/`yes` is treated as off.

Nothing else is transmitted. Both the descriptor's digest and the `project_id` attached to each estimate are **salted, non-reversible** hashes (HMAC-SHA256): the descriptor digest with a fresh per-submission salt, and `project_id` with a machine-local install salt persisted at `~/.budgetary/install-salt`. The salts never leave the machine, so the server gets a stable key it cannot reverse back to a command or path. The pending store lives at `~/.budgetary/pending.json`, shared byte-for-byte with the first-party Claude Code and Codex clients, so configuring once covers every host.

## Reference

For the v1 API contract — endpoints, error codes, scenario labels — see [docs/api-contract.md](../../docs/api-contract.md).

Licensed under [Apache-2.0](../../LICENSE).
