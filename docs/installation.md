# Installation

Every Budgetary client talks to the hosted API at `https://api.budgetary.tools` using a bearer key. Get one from the dashboard, then pick the client(s) you want.

> **Status:** all clients in this repository are stubs in the bootstrap release. Install commands below will work once each package ships its first real version.

## TypeScript / JavaScript SDK

Once published to npm at 1.0, the canonical install is the same for every package manager:

```bash
pnpm add @budgetary/sdk
# or: npm install @budgetary/sdk / yarn add @budgetary/sdk
```

Before 1.0 the SDK is installed from this repository, and only **pnpm** can do that — npm and yarn cannot install from a git subdirectory and will silently install the wrong package. See [sdk/typescript/README.md](../sdk/typescript/README.md#install) for the exact pre-1.0 command.

Configure the client with your API key (typically via environment variable):

```ts
import { BudgetaryClient } from "@budgetary/sdk";

const budgetary = new BudgetaryClient({
  apiKey: process.env.BUDGETARY_API_KEY!,
});
```

## Python SDK

```bash
pip install budgetary
```

```python
from budgetary import BudgetaryClient

client = BudgetaryClient(api_key=os.environ["BUDGETARY_API_KEY"])
```

## VS Code extension

Install **Budgetary** from [Open VSX](https://open-vsx.org/extension/budgetary/budgetary-vscode) — the extension is published there, not to the Microsoft VS Code Marketplace. After install, run the `Budgetary: Sign In` command and paste your API key when prompted.

## Claude Code plugin

Install from this repository's marketplace, inside Claude Code:

```text
/plugin marketplace add thriftell/budgetary-clients
/plugin install budgetary@budgetary
/reload-plugins
```

Claude Code prompts for your API key during install (stored in your system
keychain). See [../clients/claude-code/README.md](../clients/claude-code/README.md)
for configuration and how the predicted-vs-actual loop works, and
[claude-code-plugin-runbook.md](./claude-code-plugin-runbook.md) for community-directory
submission.

## Codex plugin

Installation instructions will land alongside the first published Codex release.

---

For the wire-level contract, see [api-contract.md](./api-contract.md).
