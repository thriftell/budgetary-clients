# @budgetary/mcp

A single [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP-capable host — Claude Code, Cursor, GitHub Copilot, Codex, and others — a pre-flight, probabilistic **token-spend estimate** for a coding task before you run it, and a best-effort, never-fabricated way to record what the task actually cost. Build it once; add it everywhere. It replaces the previously-planned per-host extensions.

The server exposes exactly one model-invokable tool, `estimate`. It talks to the hosted Budgetary API at `https://api.budgetary.tools`.

## Install — one command per host

Pass your key as `BUDGETARY_API_KEY` and tag the host with `BUDGETARY_HOST` so ledger entries distinguish where the estimate came from. Always include `-y` with `npx` so the launch never blocks on an install prompt.

### Claude Code

```bash
claude mcp add budgetary \
  --env BUDGETARY_API_KEY=bg_live_... \
  --env BUDGETARY_HOST=claude-code \
  -- npx -y @budgetary/mcp
```

(The bundled Claude Code plugin in this repo also wires the server automatically via its `.mcp.json`, with `BUDGETARY_HOST=claude-code`.)

### Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "budgetary": {
      "command": "npx",
      "args": ["-y", "@budgetary/mcp"],
      "env": {
        "BUDGETARY_API_KEY": "bg_live_...",
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
  --env BUDGETARY_API_KEY=bg_live_... \
  --env BUDGETARY_HOST=codex \
  -- npx -y @budgetary/mcp
```

…or in `~/.codex/config.toml`:

```toml
[mcp_servers.budgetary]
command = "npx"
args = ["-y", "@budgetary/mcp"]

[mcp_servers.budgetary.env]
BUDGETARY_API_KEY = "bg_live_..."
BUDGETARY_HOST = "codex"
```

## API key setup

The server resolves the key in this order:

1. `BUDGETARY_API_KEY` in the server's environment (set via the host config above).
2. `~/.budgetary/config.json` → `{ "api_key": "bg_...", "base_url"? }`.

If neither is set, the `estimate` tool returns short configure-your-key guidance instead of an error — it never throws and never crashes the host.

```bash
mkdir -p ~/.budgetary
echo '{ "api_key": "bg_live_..." }' > ~/.budgetary/config.json
```

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
{ "api_key": "bg_live_...", "language": "TypeScript" }
```

It's a free-form display name — `TypeScript`, `Python`, `Go`, and so on — that the server tidies up; you don't need an exact spelling. Like `BUDGETARY_HOST`, it is a benign tag you **declare** in the environment: the language model never sets it and it is never guessed from your task description. There is intentionally no `language` argument on the `estimate` tool. If you set nothing, the estimate is simply recorded without a language — it's never required, and it never changes the estimate itself.

A plain stdio MCP server only sees the messages your host sends it, not which file you have open, so this declared value (one per host/session) is the signal it can rely on. Hosts that expose no language at all just record the estimate without one.

## Actuals — automatic where possible, manual otherwise, never fabricated

A pre-flight estimate is only half the loop; calibration needs the **realized** token counts after the run. How those are recorded depends on what the host exposes:

- **Claude Code — automatic.** This host writes a real session transcript. The session-end hook reads the true `tokens_in + tokens_out` (cache-read tokens **excluded**) and submits them — together with a short **behavior trace**: which tools the run used (`Read`, `Edit`, `Bash`, …), roughly how many tokens each, and now two raw measurements per step — *which command it ran* (a **redacted** descriptor: the program name such as `pytest` or `go test`, plus a non-reversible digest of the rest — never a raw path, argument, or command) and *whether it succeeded*. The trace is measured from the transcript, never model-supplied, and any field that can't be read reliably is simply omitted; the total still submits. No human action needed. (Codex deferred: it exposes no session-end event, so there is no auto path yet — trace forwarding is wired for Claude Code only.)
- **Cursor / Copilot / other hosts — manual.** These hosts do **not** hand a third-party server the token totals of a completed agent run, and the language model does not know them either. So you record them yourself when you have a moment:

  ```bash
  npx @budgetary/mcp report-actual
  ```

  It shows the most recent pending estimate and prompts you for the input/output token counts (read them from your host's usage UI), whether the task succeeded, and an optional duration.

> **The model never supplies token counts.** The only model-invokable tool is `estimate`. Actuals are submitted only from (a) the session-end hook reading a real transcript, or (b) the human-entered `report-actual` command. A fabricated actual would poison calibration, so there is deliberately no tool a model can call to write counts.

## Dashboard

For the predicted-vs-actual calibration dashboard, install **Budgetary** (`budgetary.budgetary-vscode`) from [Open VSX](https://open-vsx.org) — it runs in Cursor and other VS Code forks unchanged. This server does not re-implement it.

## Privacy

Only these things leave your machine, and only to `https://api.budgetary.tools`:

- The **task description** you pass to `estimate`.
- If you set it, the **language tag** you declared (e.g. `TypeScript`) — a benign label, the same kind of thing as the host name. Never sent unless you opt in via `BUDGETARY_LANGUAGE` or the config `language` field.
- After a run, the **token counts** (`tokens_in`, `tokens_out`), a `success` flag, and a duration.
- On Claude Code, a **behavior trace**: per step, the host tool name (e.g. `Read`, `Bash`), its token count, a **redacted descriptor** of what it acted on, and whether it succeeded. The descriptor is the *program name in the clear* (e.g. `pytest`, `npm run`) plus a **non-reversible digest** of the rest of the command — or, for a file tool, a bare digest of the path. **No file contents, absolute paths, command arguments, or output ever leave the machine** — only the program name and an opaque key. Set `BUDGETARY_TRACE_TARGET=off` to drop the descriptor entirely (the trace falls back to tool names + token counts).

Nothing else is transmitted. The descriptor's digest and the `project_id` attached to each estimate are both **non-reversible SHA-256 hashes** — they give the server a stable key without revealing the underlying command or path. The pending store lives at `~/.budgetary/pending.json`, shared byte-for-byte with the first-party Claude Code and Codex clients, so configuring once covers every host.

## Reference

For the v1 API contract — endpoints, error codes, scenario labels — see [docs/api-contract.md](../../docs/api-contract.md).

Licensed under [Apache-2.0](../../LICENSE).
