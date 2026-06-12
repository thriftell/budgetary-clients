# Runbook — listing `@budgetary/mcp` in the official MCP registry

This is the manual procedure for publishing (and updating) the Budgetary server's
entry in the **official MCP registry** (`registry.modelcontextprotocol.io`). The
entry advertises both install paths from one [`clients/mcp/server.json`](../clients/mcp/server.json):
the npm **stdio** package `@budgetary/mcp` and the remote **Streamable-HTTP**
endpoint `https://api.budgetary.tools/mcp`.

> **Scope.** This covers the MCP registry only. The Claude Code plugin
> marketplace (0014b-2) and the Codex marketplace (0014b-3) are separate, later
> work and are **not** covered here.

> **Preview.** The registry is explicitly in preview: *"Breaking changes or data
> resets may occur before general availability."* Re-verify the schema date and
> CLI flags against the live docs before each publish — see
> [Re-verify before publishing](#re-verify-before-publishing).

---

## What's already in the repo

This PR (0014b-1) landed the authoring artifacts; publishing is a deliberate,
manual follow-up:

- [`clients/mcp/server.json`](../clients/mcp/server.json) — the registry entry,
  validated against schema `2025-12-11`. Server name **`io.github.thriftell/budgetary`**.
- [`clients/mcp/package.json`](../clients/mcp/package.json) — carries the
  `"mcpName": "io.github.thriftell/budgetary"` ownership-linking field the registry
  reads from the published npm tarball.
- A changeset that republishes the same server as **`@budgetary/mcp@0.1.1`** so a
  published tarball actually contains `mcpName` (the live `0.1.0` predates it).

## Namespace + auth (decided)

- **Namespace: `io.github.thriftell/budgetary`** — GitHub-org-authenticated. The
  registry grants `io.github.{org}/*` to an authenticated member of that GitHub
  org, so owning the **`thriftell`** org proves ownership with no DNS record. This
  is the lowest-friction path and the one chosen.
- The DNS-verified alternative (`tools.budgetary/...` via a `v=MCPv1; …` TXT
  record on `budgetary.tools`) is **not** used — nicer branding, but it needs DNS
  plumbing we don't need for discoverability. If you ever want it, see
  ["Switching to a DNS namespace"](#optional-switching-to-a-dns-namespace).

> **Org-role caveat (unverified).** The docs confirm `io.github.{org}/*` works and
> that a PAT needs `read:org` + `read:user`, but they do **not** state the minimum
> org role (any member vs. owner; public vs. private membership) required to be
> authorized. The publisher (Ricky) is an owner of `thriftell`, so this is moot in
> practice — but if `login` reports a namespace-permission error, check that your
> `thriftell` membership is **public**, or use a PAT with the scopes above.

---

## Publish procedure (in order)

The order matters: the registry fetches the **published** npm tarball to confirm
its `mcpName` equals the server.json `name`, so npm must publish **first**.

### 1. Ship `@budgetary/mcp@0.1.1` to npm (carries `mcpName`)

1. Merge this PR (0014b-1) to `main`.
2. The changesets bot opens a **"Version Packages"** PR bumping
   `@budgetary/mcp` `0.1.0 → 0.1.1`. Merge it.
3. [`release.yml`](../.github/workflows/release.yml) runs `changeset publish`,
   sending `@budgetary/mcp@0.1.1` to npm with provenance.
4. **Verify the tarball carries the linking field** before touching the registry:

   ```bash
   npm view @budgetary/mcp version          # -> 0.1.1
   npm view @budgetary/mcp mcpName           # -> io.github.thriftell/budgetary
   ```

   If `mcpName` is empty, the registry publish will fail at the ownership check —
   stop and fix the package first.

### 2. Confirm `server.json` references the published version

`clients/mcp/server.json` pins both the top-level `version` and
`packages[0].version` to **`0.1.1`**. Confirm they match what npm actually
published (step 1.4); if the released version differs, update `server.json`
to match before publishing.

### 3. Install `mcp-publisher`

```bash
brew install mcp-publisher           # macOS/Linux (Homebrew) — documented default
mcp-publisher --help                 # sanity check
```

Or grab the pre-built binary from the registry's GitHub releases if you don't use
Homebrew (see the [official quickstart](https://modelcontextprotocol.io/registry/quickstart)).

### 4. Validate locally (no auth, no publish)

```bash
mcp-publisher validate clients/mcp/server.json
```

This is the canonical pre-publish check (there is **no** `--dry-run` on
`publish`). It reports JSON/schema/semantic issues with JSON-path locations.

### 5. Authenticate to the `io.github.thriftell` namespace

```bash
mcp-publisher login github
```

This runs a GitHub OAuth **device flow**: it prints a code, you open
`https://github.com/login/device`, enter the code, and authorize as a member of
the `thriftell` org. Credentials are stored at `~/.config/mcp-publisher/token.json`.

### 6. Publish

```bash
mcp-publisher publish clients/mcp/server.json
```

`publish` validates against the schema, then the registry independently
re-verifies npm ownership (the `mcpName` match) and namespace authentication.
On success it prints `✓ Successfully published`.

### 7. Verify the listing resolves and is discoverable

```bash
# Resolves in the registry API:
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.thriftell/budgetary"
```

Then confirm an MCP client can **discover + add** it and that **both** install
paths are visible — the npm stdio package (`@budgetary/mcp`, with the
`BUDGETARY_API_KEY` input) and the remote endpoint
(`https://api.budgetary.tools/mcp`).

---

## Updating the listing later

- **New server version / metadata change:** bump `@budgetary/mcp` via a changeset
  (npm publishes the new version with `mcpName`), update `server.json`'s
  `version` and `packages[0].version` to match, then repeat steps 4–7.
- **Lifecycle:** `mcp-publisher status --status <active|deprecated|deleted> io.github.thriftell/budgetary [version]`.

---

## Automation decision

**Now: manual, runbook-driven (this document).** The registry is in preview and
publishing is low-frequency (a server-metadata change is rare), so a documented
manual publish is the right amount of process for 0014b-1 — it keeps a human in
the loop while the registry's contract is still moving.

**Later (noted, not wired): a gated CI re-publish on version bump**, mirroring the
0014a Open VSX job's self-gating pattern in [`release.yml`](../.github/workflows/release.yml).
The registry **does** support unattended CI auth today via GitHub Actions OIDC
(`mcp-publisher login github-oidc`, needs `permissions: id-token: write`, **no**
stored secret), so the path is open. A future job would:

1. Run **after** the npm publish job (the tarball must exist first).
2. Self-gate on whether `io.github.thriftell/budgetary@<version>` is already in the
   registry (query the `/v0.1/servers` API), exactly as the Open VSX job gates on
   a version-existence check — so it publishes **only** on an actual version
   change and is safe to re-run.
3. `mcp-publisher login github-oidc` → `mcp-publisher publish clients/mcp/server.json`.

Sketch (do **not** enable until the registry is GA and the gate is tested):

```yaml
  mcp-registry:
    needs: release
    if: needs.release.result == 'success'
    runs-on: ubuntu-latest
    permissions:
      id-token: write      # OIDC identity for mcp-publisher (no secret needed)
      contents: read
    steps:
      - uses: actions/checkout@v6
      - name: Gate — is io.github.thriftell/budgetary@<version> already listed?
        id: gate
        run: |
          VERSION=$(node -p "require('./clients/mcp/server.json').version")
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          if curl -fsSL "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.thriftell/budgetary" \
             | grep -q "\"version\":\"$VERSION\""; then
            echo "needs_publish=false" >> "$GITHUB_OUTPUT"
          else
            echo "needs_publish=true" >> "$GITHUB_OUTPUT"
          fi
      - name: Install mcp-publisher
        if: steps.gate.outputs.needs_publish == 'true'
        run: curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
      - name: Login (OIDC) + publish
        if: steps.gate.outputs.needs_publish == 'true'
        run: |
          ./mcp-publisher login github-oidc
          ./mcp-publisher publish clients/mcp/server.json
```

---

## Re-verify before publishing

Because the registry is in preview, re-check these before any publish:

- The current schema date — `clients/mcp/server.json`'s `$schema` is
  `…/schemas/2025-12-11/server.schema.json`. If the CHANGELOG shows a newer dated
  schema, run `mcp-publisher validate` (it flags deprecated-schema versions and
  prints migration guidance) and bump the `$schema` URL if needed.
- The CLI command surface (`init`, `login`, `validate`, `publish`, `status`,
  `logout`) and that `publish` still takes a positional path.

Canonical sources (primary):

- Quickstart: <https://modelcontextprotocol.io/registry/quickstart>
- Authentication / namespaces: <https://modelcontextprotocol.io/registry/authentication>
- GitHub Actions (OIDC/PAT): <https://modelcontextprotocol.io/registry/github-actions>
- CLI reference: <https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md>
- Schema + CHANGELOG: <https://github.com/modelcontextprotocol/registry/tree/main/docs/reference/server-json>

---

## (Optional) Switching to a DNS namespace

Only if you later prefer `tools.budgetary/budgetary`-style branding over
`io.github.thriftell/…`:

1. Generate an Ed25519 keypair; publish a TXT record on the apex domain:
   `budgetary.tools. IN TXT "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"`.
2. `mcp-publisher login dns --domain "budgetary.tools" --private-key "${PRIVATE_KEY}"`.
3. Change `server.json` `name` **and** `package.json` `mcpName` to the new
   reverse-DNS name (they must stay equal), republish the npm patch, then publish.
