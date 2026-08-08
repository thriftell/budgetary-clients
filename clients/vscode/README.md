# Budgetary for VS Code

A [VS Code](https://code.visualstudio.com/) extension that shows your Budgetary **predicted-vs-actual** token-spend ledger as a calibration scatter plot and recent-estimates table. Read-only: the extension only consumes `/v1/ledger`; it never submits anything.

> _Screenshot to be added once real calibration data exists._
> The dashboard renders a hand-drawn SVG scatter (predicted p50 on the x-axis, actual total on the y-axis, both log scale) with a `y=x` reference line and points colored by scenario. It honors the active VS Code theme via CSS variables.

The table beneath it lists each estimate with its predicted band, its realized total, the **Measured** phase breakdown of that spend, and the **Normal?** verdict on where the total landed against the prediction. The last two are reported by the API and printed as received; where it reports none, the cell is an em-dash rather than a guess.

## Install

Published on the [Open VSX Registry](https://open-vsx.org/extension/budgetary/budgetary-vscode) as `budgetary.budgetary-vscode`. In an editor that installs from Open VSX, search the Extensions view for **Budgetary**, or install the identifier from your editor's CLI:

```bash
codium --install-extension budgetary.budgetary-vscode
```

Alternatively, download the `.vsix` from that listing and install it with **Extensions: Install from VSIX…** in the command palette.

Then run:

> **Budgetary: Show Dashboard**

from the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).

## Develop locally

```bash
git clone https://github.com/thriftell/budgetary-clients
cd budgetary-clients
pnpm install
pnpm -r build
```

Open the repo in VS Code, switch to the **Run and Debug** view, and pick **Run Extension** (or press F5). VS Code launches a new Extension Development Host with the extension loaded, where the same **Budgetary: Show Dashboard** command is available.

## Configure the API key

The extension reads the API key from the same locations as the Claude Code plugin — so if you've already configured one, you don't have to do it again. In order:

1. `BUDGETARY_API_KEY` environment variable.
2. `~/.budgetary/config.json` → `{ "api_key": "bg_...", "base_url": "..." }` (optional `base_url`).

```bash
export BUDGETARY_API_KEY=bg_test_...

# or, persistently:
mkdir -p ~/.budgetary
echo '{ "api_key": "bg_test_..." }' > ~/.budgetary/config.json
```

A **`bg_test_`** key is the free testing tier and works immediately; **`bg_live_`** is the production key (and must be on an active plan).

If neither is set, the dashboard opens a **Configure your key** panel instead of crashing. The API key never appears in webview HTML, error messages, or logs.

## Commands

| Command | Description |
|---|---|
| `Budgetary: Show Dashboard` | Open (or re-focus) the dashboard webview. |

The dashboard has a refresh button in the top right that re-fetches your ledger.

## Privacy

The extension only reads your own ledger from `https://api.budgetary.tools`. No other data leaves the machine. The webview enforces a strict Content-Security-Policy: no external scripts, no external styles, no remote fonts. The only script is a single nonce-bound inline `<script>` that wires the refresh button.

## Reference

For the v1 API contract — endpoints, error codes, scenario labels — see [docs/api-contract.md](https://github.com/thriftell/budgetary-clients/blob/main/docs/api-contract.md).

Licensed under [Apache-2.0](https://github.com/thriftell/budgetary-clients/blob/main/LICENSE).
