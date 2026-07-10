# Contributing

Thanks for your interest in Budgetary clients.

We welcome **issues** — bug reports, ideas, and questions. File one at
<https://github.com/thriftell/budgetary-clients/issues>.

Pull requests are reviewed **case-by-case** while the project is in early
access. If you're planning a non-trivial change, please open an issue
first so we can talk through the design before you spend time on a patch.

By contributing you agree that your contributions will be licensed under
the [Apache License 2.0](./LICENSE).

## Development

This is a pnpm workspace of TypeScript packages plus a standalone Python SDK.

### Prerequisites

- **Node 22** and **pnpm 10**. The repo pins the package manager via
  `packageManager` in the root `package.json`, so the simplest path is to let
  [corepack](https://nodejs.org/api/corepack.html) manage pnpm:

  ```bash
  corepack enable
  ```

  A `.nvmrc` isn't required — `engines.node` is `>=22`.
- **Python 3.10+** for the Python SDK (`sdk/python`).

### TypeScript packages (`sdk/typescript`, `clients/{mcp,vscode}`)

Install once, then **build before test** — several packages consume the built
output of `@budgetary/sdk`, and CI runs the two in that order for the same
reason:

```bash
pnpm install
pnpm -r build     # dependency order: sdk before mcp
pnpm -r test
```

`pnpm -r build && pnpm -r test` is the same gate CI runs; run it before opening
a PR. (The `clients/{claude-code,codex}` plugins are manifest-only wrappers with
no build/test step; `pnpm -r` skips them.)

### Python SDK (`sdk/python`)

```bash
cd sdk/python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
mypy            # strict; config in pyproject.toml
```

The Python and TypeScript SDKs implement the **same** `/v1` contract and must
stay behavior-compatible — every `sdk/**` change should tick the
[SDK parity checklist](./docs/sdk-parity.md).

### Changesets

**Every user-visible change to a published package needs a changeset:**

```bash
pnpm changeset
```

Pick the affected package(s) and a semver bump, and write a one-line,
user-facing summary. A PR that changes `@budgetary/sdk`, `@budgetary/mcp`, or
`budgetary-vscode` without a changeset will not produce a release entry.

Changesets does **not** cover the Python SDK (see the release map below), and
the `@budgetary/{claude-code,codex}` plugin packages are in the changesets
`ignore` list — they ship from git, not a registry.

`@budgetary/mcp` is published as a **bundle**: `@modelcontextprotocol/sdk` and
`zod` are compiled into `dist/` at build time, so a fix in either only reaches
users when the mcp package is *rebuilt and republished*. Bumping one of those
bundled dependencies therefore needs its own `@budgetary/mcp` changeset —
changesets can't infer it, because they're `devDependencies` of mcp, not
runtime `dependencies`. `@budgetary/sdk` is the exception: it's kept an external
runtime `dependency` (`workspace:*`, not bundled), so changesets already
auto-republishes mcp whenever the SDK changes.

### Release flow

| What | How |
|---|---|
| `@budgetary/sdk`, `@budgetary/mcp` | Changesets. Merging PRs with changesets opens a **Version Packages** PR; merging *that* runs `changeset publish` → **npm** (with provenance). |
| `budgetary-vscode` | Version-bumped by changesets (it's private, never on npm); a separate gated job publishes it to **Open VSX**. |
| `@budgetary/{claude-code,codex}` plugins | `ignore`d by changesets. They ship from this repo's git via the Claude Code / Codex plugin marketplaces (see the runbooks below) — not from a registry. |
| `budgetary` (Python SDK) | **Manual.** Bump `version` in `sdk/python/pyproject.toml`, commit, then tag `sdk-py-vX.Y.Z` and push the tag → the `publish` workflow builds and publishes to **PyPI** (trusted publishing). |

Runbooks for the plugin/registry channels:
[Claude Code plugin](./docs/claude-code-plugin-runbook.md) ·
[Codex plugin](./docs/codex-plugin-runbook.md) ·
[MCP registry](./docs/mcp-registry-runbook.md).
