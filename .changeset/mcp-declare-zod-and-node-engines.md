---
"@budgetary/mcp": patch
---

Declare `zod` as a direct dependency (`^4.0.0`) instead of relying on it as an auto-installed peer of `@modelcontextprotocol/sdk`, so strict installs (`auto-install-peers=false`, Yarn PnP) resolve it reliably. Also declare `engines: { node: ">=22" }`, which the code already assumes.
