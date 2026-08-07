---
"@budgetary/mcp": patch
---

Let a one-click registry install say which host it is running under.

The MCP registry listing declared a single environment variable, `BUDGETARY_API_KEY`, so an install made from it started the server with no `BUDGETARY_HOST`. The host then resolved to the generic `mcp` default — honest, but also the one value that suppresses the first-run notice about nothing submitting your finished runs. The install path with the least setup was the one least likely to hear about the gap it has.

- `server.json` now declares `BUDGETARY_HOST` as an optional, non-secret variable whose description names the values that matter, so an install made from the listing can identify itself the way a hand-written host config already does.
- The README documents the registry path: what it offers, why to fill that field in even though it is optional, and what the listing's remote endpoint can and cannot do — it estimates only, and has no local process that could measure what a run actually cost.

Nothing in the server changed. `BUDGETARY_HOST` remains a tag and only a tag: it says which host this is, never whether anything is wired to submit a finished run. A test now holds the manifest to that — nothing it declares may be read as evidence of an automatic path, and it may never declare the one variable that is.
