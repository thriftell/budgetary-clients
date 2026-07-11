# @budgetary/mcp

## 0.4.0

### Minor Changes

- 46ef9d6: Pending-store scalability: serialize concurrent writes, bound growth, surface dropped traces.

  - **Serialize the read-modify-write.** The shared `~/.budgetary/pending.json` was mutated under an unlocked read → mutate → write, so at 2–10 parallel agent sessions two writers off one snapshot last-writer-win — silently dropping a calibration pair _after_ "stored ✓". Every store mutation (`append`, the session-end submit's remove/bump/drop, the TTL sweep) now runs under a fail-open advisory lock (`pending.json.lock`, O_EXCL, ~8 jittered retries, 10 s stale-break, released in `finally`). On contention it **fails open** to the prior unlocked behavior rather than risk the 30 s hook budget. A regression test proves 40 concurrent appending processes lose zero entries (they lose several with the lock disabled).
  - **Bound hook-less growth.** Hosts without a session-end hook (Codex/Cursor/Copilot) never sweep, so their queue grew unbounded (~12.5k entries/yr). `append` now sweeps expired entries (24h TTL, shared rule), hard-caps at 1,000 entries with oldest-eviction, and truncates the stored `query` to 160 chars (it is local-only, never sent to the server). Stale `pending.json.*.tmp` orphans from a crashed writer are reaped opportunistically.
  - **Honest trace-drop.** When a session's execution trace exceeds the cap it is dropped whole (a trimmed trace would misstate composition) — previously this was silent and read identically to a tool-free run. The drop is now recorded on the session-end breadcrumb ("trace over cap: N steps / M bytes — totals only") and emitted under `BUDGETARY_DEBUG`. No wire field changes; totals still submit.

### Patch Changes

- 3b1a646: Fleet good-citizenship: de-synchronize retries and honor host cancellation.

  - **Jitter above the `Retry-After` floor (both SDKs).** The 429 backoff was `min(max(retryAfter, computed), maxDelay)` — deterministic, so a correlated fleet all seeing the same `Retry-After: 1` at a fixed-window boundary re-synchronized into one bucket and thundering-herd'd the engine the instant the window opened (demonstrated: 40/40 clients collapse into one 1 s bucket). It is now `min(retryAfter*1000 + random()*computed, maxDelay)` — the server's floor still holds and the clamp still bounds a hostile header, but jitter is added on top so the fleet spreads across `[retryAfter, retryAfter+computed)`. Same change in the Python SDK (`_internal/retry.py`); existing floor/clamp tests unchanged, an injected-random de-sync test added to each.
  - **Honor host cancellation (TS SDK + MCP).** `estimate` gained a `signal?: AbortSignal` option. The MCP server now threads the host's per-request `AbortSignal` (`extra.signal`) through `handleCallTool` → `runEstimateTool` → `estimate`, combined with the per-attempt timeout via `AbortSignal.any`, and the retry backoff sleep is signal-aware. So a host that abandons an interactive estimate stops retrying immediately — shedding load exactly during a shared outage — instead of finishing its full ~5 min ladder against a struggling engine for a result no one will read. (The unattended actuals path is already `maxRetries: 0`; the Python sync client has no host-cancel channel — N/A.)

- Updated dependencies [3b1a646]
  - @budgetary/sdk@0.6.0

## 0.3.0

### Minor Changes

- a1ed86d: Pair each cross-session actuals retry with the RIGHT data, so a later session's
  usage can never attach to an older estimate (P-B1). This is what makes the
  non-interactive paths' `maxRetries: 0` safe: a failed submit is retried on a
  later session, and that retry must resubmit the ORIGINAL run's counts, not
  whatever the retrying session measured.

  - **Persist measured counts on a failed submit (part 1, load-bearing).** When a
    submit fails and the entry is kept (a retryable 5xx/network error, or a
    user-fixable 401/403), the measured `{tokensIn, tokensOut, success, durationMs,
hasTrace}` are stamped onto the pending entry as **additive, optional** fields.
    A later session's auto path then resubmits THOSE counts — baked in, never
    re-derived from a different transcript — so the retry can't mis-pair. The store
    file stays `version: 1`; the new fields are re-validated at read time, so a
    partial/corrupt write is ignored (fall back to a fresh read), never trusted.
    On the happy path (first submit succeeds) nothing changes.
  - **Session-bind the fresh auto-close (part 2, forward-looking).** A fresh
    (never-submitted) entry is only closed with this session's transcript when it
    was created DURING the ending session, compared against `payload.started_at`.
    Today's Claude Code SessionEnd payload does not carry `started_at` (nor does
    Codex's Stop payload), so this falls back to the existing project binding —
    part 1 carries the protection in that case, and the session binding activates
    automatically for any host that sends `started_at`. Bias is toward not
    mis-pairing: a stale entry with no persisted counts is left for its own retry
    or the 24h TTL, never paired with foreign usage.

  The manual (`report-actual`) and rollout (`on-session-end --transcript`) paths
  are human-directed and unchanged, except that a failed submit on those paths
  also persists its counts, so the auto path can later retry them.

- 880ffb2: Add operator self-service and stop the silent-hang: `main()` dispatched only 3
  subcommands, so `--version`, `--help`, and any typo fell through to
  `runStdioServer()` and blocked — the documented `npx -y @budgetary/mcp` smoke
  test looked like a freeze, and there was no way to check connectivity/key/config
  short of a billed estimate.

  - **No silent hang.** Only a bare invocation (no arguments) starts the stdio
    server. `--version`/`-v`/`version` prints the version; `--help`/`-h`/`help`
    prints usage; an unknown subcommand prints usage to stderr and exits 2. A
    one-line version banner is written to **stderr** at server start (stdout stays
    the JSON-RPC channel) so a bare launch shows a sign of life.
  - **`doctor` subcommand.** Prints the version, the key **source + prefix**
    (`bg_live_`/`bg_test_` — never the value), the **resolved base URL**, the
    pending path + count, and the last automatic-run breadcrumb; then makes ONE
    authenticated `GET /v1/ledger?limit=1` (the existing endpoint — no new API,
    `maxRetries: 0`) and classifies the result through the SDK's error taxonomy
    (200 / 401 / 403 / 429-is-valid / network-names-the-host).
  - **Config transparency (O-7).** `doctor` (and the new `configDiagnostics`) warn
    when a config-file `base_url` was **refused** (non-HTTPS → silently fell back to
    the prod default) or **shadowed** by an env key that short-circuits before the
    file is read. Traffic could otherwise hit prod while the operator believed
    otherwise — surfacing the resolved URL + the reason is the fix.

- 33b40cf: Make the unattended session-end path observable. The auto actuals hook (where
  100% of default calibration data flows) previously exited 0 with zero bytes on
  success, on every no-op reason, and on failure — a lost actual vanished from the
  queue with no signal anywhere.

  - **Durable breadcrumb.** Every `runAutoActuals` run now leaves
    `~/.budgetary/last-session-end.json` — `{ startedAt, durationMs, outcome,
estimateId }` — best-effort and never-throws. `outcome` is one of `submitted`,
    `no-entry`, `no-usage`, `no-key`, `dropped-ttl` (the sweep dropped entries),
    `stale-skip` (the matched entry was kept but not this session's), `rejected`,
    `gave-up`, `failed:<code>`, or `error`. A start-only record (overwritten on
    completion) is the interrupted-run marker: if the host SIGKILLs the hook past
    its 30 s timeout, the absent `durationMs`/`outcome` says so. The API key is
    never written.
  - **`BUDGETARY_DEBUG=1`** narrates every decision on stderr (source + resolved
    base URL, matched estimate, transcript counts, submit outcome + `request_id`,
    and the _reason_ each no-op returned) — never the key value. Off by default;
    stdout stays the pure JSON-RPC channel.
  - **Transcript failures are named.** A new `transcriptUnreadableReason` re-derives
    why a transcript yielded no counts (missing / non-regular / over-cap / empty /
    unrecognized format) so a Claude Code transcript-format change is diagnosable
    under the flag instead of silently killing every future submission.
  - **`pending` surfaces it.** A one-line header reports the last automatic run
    ("Last automatic submission: submitted (est\_…), 3h ago" or an interrupted-run
    note), so an empty queue is explained rather than merely blank.

### Patch Changes

- a475a2f: Make a retry ordeal legible instead of opaque (O-6).

  **@budgetary/sdk (both TypeScript and Python)**

  - On the final throw, the retry wrapper now stamps two additive, diagnostic
    fields onto the `BudgetaryError`: `attempts` (1-based — `1` for a first-attempt
    terminal failure, up to `maxRetries + 1` on exhaustion) and `totalElapsedMs` /
    `total_elapsed_ms` (wall-clock across every attempt + backoff). A ~4-minute
    429/5xx backoff no longer reads as a first-attempt blip. The error type is
    unchanged.
  - An optional `onRetry` / `on_retry` observer on the client options fires before
    each backoff sleep with the attempt count, the delay about to be slept, and the
    HTTP status. Purely diagnostic — a throw from it is swallowed and never derails
    the request. (`RetryInfo` / `OnRetry` are exported for typing.)
  - **TypeScript only:** `mapNetworkError` now appends `err.cause?.message` and the
    target **host** to the message, so a transport failure surfaces the real reason
    (`connect ECONNREFUSED …`) and where it was headed instead of the opaque
    `"fetch failed"`. (Python already interpolated this.) Host only — never the
    path/query.

  **@budgetary/mcp**

  - The estimate tool's transport-error render shows "after N attempts over Ns"
    when the SDK exhausted its ladder, so a slow retry ordeal is visible in the host.

- 1e3ec4a: Sharpen the status surfaces so they under-report trouble less and make the
  `estimate_id` pairing key visible.

  **@budgetary/mcp**

  - `pending` rows now carry the facts that matter: `• <excerpt> — 3h ago,
4/5 attempts, measured ✓, expires in ~1h, id est_ab12…`. `attempts` shows how
    close an entry is to the give-up cap; `measured ✓` marks an entry whose counts
    were already captured on a prior failed submit (a retry resends those); the
    expiry names the 24h auto-window and notes that manual `report-actual` still
    works past it.
  - The `estimate_id` (short form) is now visible where it was invisible before:
    in the estimate render footer, in the manual/rollout submit confirmations, and
    on every `pending` row — the same short id across all three, so a user can
    correlate an estimate with its pending entry and its submission.
  - `request_id` is threaded into the auth (401), permission (403), and
    rate-limit (429) renderers, matching the transport-error renderers.
  - Honest terminal copy: an empty queue no longer claims "the loop is closed"
    (some estimates may have been dropped — gave-up / rejected / TTL-swept, which
    the last-run breadcrumb reports).

  **budgetary-vscode**

  - The dashboard surfaces the out-of-coverage void rate ("2 of the last 50
    estimates were out-of-coverage voids") from `scenario === "out_of_domain"`.
  - Out-of-domain rows render their Result cell as "no prediction" instead of the
    misleading "○ pending" — a void never receives an actual.
  - `out_of_domain` is dropped from the chart legend (it is never plotted as a
    marker, so its swatch advertised a shape the chart never draws); it still
    appears in the table's Scenario column.

- 3dd43a2: Sweep the pending store honestly at session end. `runAutoActuals` now drops
  EVERY entry older than the 24h TTL — not just the one this session would close —
  so an abandoned project's estimate can't live in the queue forever (nothing else
  ever selected it, so nothing ever expired it). The sweep re-reads first (so a
  concurrent append isn't clobbered) and emits a single warning naming the count,
  closing the last silent drop path. An unparseable or future `created_at` has an
  unknown age and is deliberately KEPT rather than discarded — dropping it could
  silently lose a session's own actual.
- Updated dependencies [a475a2f]
  - @budgetary/sdk@0.5.0

## 0.2.6

### Patch Changes

- 4965932: Trust response _bodies_ as little as the transport already trusts the network:
  close every path where a malformed 2xx becomes a crash or fabricated data.
  (Python parity changes ship in the same commit — Python is outside changesets.)

  - **Shape-validate the estimate body (fabrication guard).** `client.estimate`
    now validates the parsed 2xx before returning it: a non-empty string
    `estimateId`, a boolean `void`, and finite-number `p10`/`p50`/`p90` when not
    void — otherwise a typed `BudgetaryNetworkError("unusable response body")`. An
    empty body, a wrong-shape 200 (missing `distribution`), or a wrong-_typed_ 200
    (string percentiles — `"123"` would render as a real number and be stored as a
    fabricated estimate) is caught here instead of crashing downstream. The MCP
    `estimate` tool additionally wraps its render+store block so a malformed shape
    that reaches it degrades to graceful transport-error text and stores no pending
    entry (the tool's "never throws" contract). Python's `_parse_estimate` gains
    the matching type checks (rejecting `bool` percentiles, which are `int`
    subclasses).
  - **Deeply-nested JSON stays inside the taxonomy.** The SDK's own recursive
    walks (`assertFiniteNumbers` / `toCamelCase`) are now iterative (explicit
    worklist), so a deeply-nested 2xx can't blow the call stack with a raw
    `RangeError`; Python adds `RecursionError` to the `json.loads` except clause.
  - **`Retry-After: nan` no longer reaches `sleep`.** Python's `_parse_retry_after`
    returns a value only when it is finite, so a `nan`/`inf` header can't pierce the
    min/max clamp into `time.sleep(nan)` (a raw `ValueError`).
  - **Transcript totals fail closed on an out-of-range sum.** `readTranscriptUsage`
    now guards the SUMMED totals (not just each field): an overflow to `Infinity`
    or past `Number.MAX_SAFE_INTEGER` — which `JSON.stringify` serializes as `null`
    on the wire — makes the reader submit nothing instead of a corrupt actual.

- 1b6c470: Harden the pending-store read/write surface so an environmental fault degrades
  instead of corrupting the queue or crashing the session-end hook.

  - **Never clobber an unreadable queue.** `PendingStore` no longer pre-checks the
    file with `existsSync` (which returns `false` for _any_ error — a lost read
    permission on `~/.budgetary`, EIO, a directory in the way). It reads directly
    and classifies by errno: `ENOENT` is a genuine first run (empty + writable);
    every other read failure fails closed (empty + **not** writable), so the next
    `append` refuses rather than overwriting whatever bytes are there with a fresh
    one-entry file. The whole queue is preserved with a warning.
  - **A `store.write` fault no longer crashes the hook after a successful POST.**
    Each `store.write` in the submit path and the TTL-drop is now best-effort: on
    a post-success remove failure the submit is still reported `submitted: true`
    (a committed submit is never reclassified as retryable — a leftover entry is
    reconciled next session by the server's `estimate_id` dedup); bump/drop write
    failures return the computed outcome without persisting. A last-resort guard in
    the session-end CLI (and a `main()` backstop) keeps the hook's exit-0 contract:
    an unforeseen throw exits 0 with one stderr line, never a raw stack; the
    foreground `report-actual` / `on-session-end --transcript` / `pending`
    subcommands surface a clean message instead of a stack trace.

- Updated dependencies [4965932]
  - @budgetary/sdk@0.4.1

## 0.2.5

### Patch Changes

- a235ce3: Bundle the server so its heavy runtime dependencies drop from 3 to 1.

  `@budgetary/mcp` is launched with `npx -y @budgetary/mcp` — a fresh install on
  every (pinned) version bump and in every ephemeral environment (devcontainers,
  cloud sandboxes). Two of its three runtime dependencies (`@modelcontextprotocol/sdk`
  and `zod`) transitively pulled the MCP SDK's entire HTTP-server stack — express,
  hono, jose, eventsource, cors, cross-spawn — about 95 packages / ~22 MB /
  ~3,600 files on a cold `npx`, none of which the stdio server reaches.

  The package now builds with tsup (esbuild) and bundles `@modelcontextprotocol/sdk`
  and `zod` into a single self-contained tree (the HTTP stack tree-shakes away; the
  JSON-schema validation the SDK actually uses — ajv and its deps — is retained,
  bundled into the output). Those two move to
  `devDependencies`. `@budgetary/sdk` is deliberately kept as an external,
  exact-pinned runtime `dependency` (not bundled), so changesets keeps
  auto-republishing `@budgetary/mcp` whenever the workspace SDK changes and an SDK
  fix reaches the fleet without a bundle rebuild. A cold `npx -y @budgetary/mcp`
  now downloads the one mcp bundle plus that single zero-dependency SDK tarball —
  two small packages instead of 95 / ~22 MB.

  The output is intentionally unminified (this is a public, npm-provenanced
  package, so the shipped bytes stay auditable), and the bundled third-party
  license notices are collected into `dist/THIRD-PARTY-NOTICES.txt` at build time.

  No public API or runtime behavior change: the `exports` map, `bin`, the
  `estimate` tool surface, and the `initialize` + `tools/list` handshake are
  identical, and the version is still read from the package's own `package.json`
  at runtime. Verified with a stdio handshake run against only the bundle plus the
  external SDK (the MCP HTTP stack absent), `attw` (green under the esm-only
  profile, now also gated in CI), and a packed `dependencies` of just
  `@budgetary/sdk`.

- 34bd3d9: Trim session-end hook latency, behavior-preserving.

  - **Cap retries on the non-interactive actuals submit paths.** The auto
    session-end hook, the rollout `on-session-end --transcript`, and the manual
    `report-actual` now construct the SDK client with `maxRetries: 0` (no
    in-process retry). During a server outage the SDK's default ladder (4 retries,
    ~7.5–15 s of backoff sleeps) would run inside the 30 s session-end host budget
    and delay process exit; and because the SDK honors a `429` `Retry-After` as a
    floor (clamped to 60 s), even a single retry could sleep past the budget and
    get the hook killed mid-wait — the exact hang this cap prevents. A failed
    submit stays pending and is retried on a later session (durable cross-session
    retry), which is strictly better than blocking exit on in-process sleeps. The
    interactive `estimate` path is deliberately left at the full retry ladder — a
    user is waiting there for the result.
  - **Parse each Claude Code transcript once.** The Codex-dialect probe now
    fast-rejects when the `token_count` marker is absent (the dominant Claude Code
    hook path), instead of doing a full `split` + per-line `JSON.parse` that the
    per-turn parser then repeats. A coincidental `token_count` in a Claude
    transcript is harmless — the probe runs as before and still falls through.

## 0.2.4

### Patch Changes

- b564e75: Harden local secret handling and bound unbounded reads.

  - **Restrict `~/.budgetary` permissions.** The store directory is created owner-only (`0700`) — and an already-loose one is tightened — and `pending.json` is written owner-only (`0600`) via a create-exclusive temp (`wx`, which also refuses to follow a planted symlink). The directory holds `config.json` (the API key) and the file holds pending task queries, so neither should be group/world accessible.
  - **Bound the transcript read.** `readTranscriptUsage` size-guards the (caller-supplied) transcript path before reading it whole into memory; an over-cap file fails closed (submits nothing), exactly like any other unreadable input.
  - **Bound the stdin accumulator.** The `on-session-end` hook path caps the session-end payload it reads from stdin and fails closed over the cap, so a huge/hostile stdin can't exhaust memory.
  - **Validate the key shape on the hook path.** The unattended auto-actuals path now checks the resolved key matches the documented `bg_live_`/`bg_test_` shape (permissively) before use, and skips submission for an unrecognized value.

  The Claude Code session-end hook still passes the key on its command line — Claude Code _command_ hooks have no `env` map, so the key is briefly visible in the process list on a shared host. This residual and its mitigations (single-user host, `~/.budgetary/config.json` at mode `0600`) are now documented in the plugin README.

- 09fc5d1: Harden the execution-trace redaction so nothing sensitive can reach the wire in the clear.

  - **Program name is now allowlist-gated, not charset-gated.** A shell step's cleartext program is exposed only when it is on a fixed allowlist of common, non-sensitive tools (`pytest`, `npm`, `go`, `git`, …). A pasted credential (`ghp_…`, `sk-…`), a private script name (`rotate_prod_keys.sh`), or any other free-form first token now degrades to a bare digest with no cleartext. Also caps the program length and rejects known secret prefixes as belt-and-suspenders.
  - **Digests are now salted (non-reversible).** Redaction digests use HMAC-SHA256 instead of a plain truncated SHA-256. The trace `target` digest uses a fresh per-submission salt (retry-equality still holds within one submission); `project_id` uses a machine-local install salt persisted at `~/.budgetary/install-salt` (owner-only), so it stays stable per install while the salt-less server cannot dictionary-reverse it back to a path or command. The salts never leave the machine.
  - **Env-assignment peel fails closed on a backslash.** A leading `VAR=val` whose value ends in a backslash (an escaped space / line-continuation) no longer splits mid-value and surfaces a later token as the program.
  - **Tool names are allowlisted.** Custom/internal MCP tool names (e.g. an org-private `mcp__acme__…`) are bucketed to `mcp:other` instead of being forwarded verbatim.
  - **Trace-target opt-out fails safe.** `BUDGETARY_TRACE_TARGET` now stays ON only for an explicit affirmative (`1`/`true`/`on`/`yes`) or the unset/blank default; any other value (including a typo like `disabled`) resolves to OFF.
  - **Build cleans `dist` first** so a stale artifact can't ship on a local publish.

  Behavior deltas (mainline unchanged): a normal command's `target` is identical except its digest is now salted; a first token that is not an allowlisted program is emitted as a bare digest rather than in the clear; `project_id` becomes a per-install salted value (a one-time regrouping of a user's historical ledger); an unrecognized `BUDGETARY_TRACE_TARGET` value now disables the descriptor instead of leaving it on. README and the API contract no longer overclaim an unsalted digest as "non-reversible".

- Updated dependencies [b647e1c]
  - @budgetary/sdk@0.4.0

## 0.2.3

### Patch Changes

- 4509caa: Declare `zod` as a direct dependency (`^4.0.0`) instead of relying on it as an auto-installed peer of `@modelcontextprotocol/sdk`, so strict installs (`auto-install-peers=false`, Yarn PnP) resolve it reliably. Also declare `engines: { node: ">=22" }`, which the code already assumes.
- Updated dependencies [4509caa]
  - @budgetary/sdk@0.3.2

## 0.2.2

### Patch Changes

- 80118ca: Changelog backfill for the dim-2 "honest presentation" UX pass. These user-facing changes shipped functionally in `@budgetary/sdk` 0.3.0 / `@budgetary/mcp` 0.2.1 / `budgetary-vscode` 0.1.2 but were released without a changeset, so they never reached the changelog. Recorded here for an honest history — there is no code change beyond this note.

  - **@budgetary/sdk:** `normalizeScenario` is now exported (an unknown scenario label folds to `uncertain`); `scenario` is widened to `Scenario | (string & {})` so an unknown server label is not a type error; the constructor now throws on an empty/whitespace API key instead of failing later with an opaque 401; and `void`, `distribution`, `confidence`, and `expiresAt` gained JSDoc.
  - **@budgetary/mcp:** estimates are presented honestly — a confident estimate leads with the point, while an uncertain / sparse-evidence / unknown one leads with the range and a caution note, and a non-billed estimate reads "This estimate wasn't billed" instead of "No charge". Failure paths are honest: a non-retryable 4xx no longer says "try again", and a terminally rejected auto-actual is now dropped **with a stderr warning** rather than silently. Codex can now close the actuals loop: `on-session-end --transcript <file>` parses the Codex rollout dialect (cumulative `token_count`, cache-read excluded) on a manual foreground path, since Codex has no session-end hook. The MCP handshake version now reflects the real package version.
  - **budgetary-vscode:** the calibration chart renders the full p10–p90 band (a whisker per point) instead of only p50; scenarios are distinguished by marker **shape** (with a legend), not color alone; and the dashboard is accessible to screen readers (labeled regions, a live-region refresh announcement, no color-only signal).

- Updated dependencies [80118ca]
  - @budgetary/sdk@0.3.1

## 0.2.1

### Patch Changes

- f44b900: Pending-store and actuals-submission integrity fixes:

  - Actuals are now bound to their own session (matched by `project_id`) before submission, so a session's realized counts can no longer be attached to a different concurrent session's estimate.
  - The shared `~/.budgetary/pending.json` no longer loses data under concurrency: the store is re-read immediately before each write, the target entry is removed by `estimate_id` rather than by position, each writer uses a unique temp file, and a single malformed entry no longer discards the whole file (an unreadable/corrupt store is left intact instead of clobbered).
  - The session-end submit persists its attempt bump **before** the network call and uses a bounded client (short retry/timeout), so a hook killed on session exit still advances toward the give-up bound instead of retrying forever, and a failing submit can't hang the host's exit.
  - `success` defaults to `false` unless a real termination signal is present.

- b4dc94f: Unify API-key resolution behind a single implementation.

  - `@budgetary/sdk` now exports the resolver — `resolveConfigStatus`, `resolveConfig`, the `ConfigStatus` / `ResolvedConfig` types, and the `configFilePath` / `budgetaryDir` path helpers.
  - The mcp server re-exports the shared resolver (its public shape and tests are unchanged) and keeps its own pending-store, language, trace-target, and guidance helpers on top.
  - The VS Code extension drops its private, drifted copy and consumes the shared resolver. **Behavior change:** an _unreadable_ `~/.budgetary/config.json` is now surfaced distinctly ("Config file could not be read") instead of being mislabeled "No API key configured", and the env/file key is trimmed — matching the mcp runtime.

- Updated dependencies [f44b900]
- Updated dependencies [62c0a20]
- Updated dependencies [b4dc94f]
  - @budgetary/sdk@0.3.0

## 0.2.0

### Minor Changes

- 8c3fc92: Forward a measured execution trace to `/v1/actuals`.

  - **SDK:** `ActualsRequest` gains an optional additive `trace` field (`ActualsTraceStep[]` — `{ tool, tokens, kind? }`). It serializes verbatim on the wire; the server classifies it into phases and drops it (without failing the call) if it is over-cap or malformed.
  - **MCP:** the Claude Code `on-session-end` auto path now attaches a per-tool trace alongside the realized total, on the **same cache-read-excluded basis**. Token usage in the real Claude Code transcript is reported **per turn** (per `message.id`), not per tool call, so a multi-tool turn's measured tokens are split evenly across its tools (`kind: "turn-split"`). The trace is real, never model-supplied, capped (≤ 512 steps / 16 KB) and fail-closed — over-cap or unreadable ⇒ the total still submits with no trace.
  - **MCP (correctness):** the transcript parser now **dedupes turn usage by `message.id`**. Real Claude Code transcripts write one JSONL line per content block, each repeating the turn's `usage`; the previous per-line summation over-counted the realized total ~3–4×. Totals are now counted once per turn (verified against real transcripts), which the trace shares.

- 018d606: Enrich the execution trace with a redacted `target` and an `ok` outcome.

  - **SDK:** `ActualsTraceStep` gains two optional additive fields — `target?: string` (a **redacted** descriptor of what the step acted on) and `ok?: boolean` (the measured outcome). Both serialize verbatim on the wire (snake-case-safe); the server reads them to classify and drops anything it doesn't use, exactly as before.
  - **MCP:** the Claude Code `on-session-end` auto path now measures, per step, _which command it ran_ and _whether it succeeded_, on the same submission and basis as the existing trace. `target` is a **redacted** descriptor — for a shell step the program name in the clear (plus the subcommand for a known driver, e.g. `go test`, `npm run`) followed by a **non-reversible** digest of the rest of the command; for a file tool, a bare digest of the path. It **never** carries a raw command, absolute path, file contents, or argument. `ok` is `!is_error` of the matching tool result, omitted when the host flagged no outcome. Both are measured from the transcript, never model-supplied, and fail closed (unreadable ⇒ field omitted; the total + base trace still submit).
  - **Privacy opt-out:** `BUDGETARY_TRACE_TARGET=off` (`0`/`false`/`no`) suppresses `target` entirely; the trace degrades to tool names + token counts (+ the leak-free `ok`). Fail-safe: any other value leaves it on.
  - **Boundary:** the client still classifies nothing — it forwards a program name, a digest, and an error flag; phase labeling and retry detection are server-side. Codex remains deferred (no session-end event); third-party hosts are unchanged.

- e986b70: Forward an optional, declared `context.language` on `/v1/estimate` so estimates can be grouped by the language you're working in.

  - **SDK:** `EstimateContext` gains an optional additive `language?: string` — a benign tag (a host display name such as `TypeScript` or `Python`), same risk class as `host`, forwarded verbatim on the wire (snake-case-safe). The server owns normalization; the SDK ships no alias table.
  - **MCP:** the `estimate` handler now resolves a language tag from the environment — `BUDGETARY_LANGUAGE`, falling back to a `language` field in `~/.budgetary/config.json` — and forwards it on the same `context` as `host`. It is **declared, never model-supplied**: there is deliberately no `language` argument on the `estimate` tool, and it is never inferred from the task text. **Fail-open:** with no signal (or a host that exposes none) the field is omitted entirely and the server records honest `(none)` — it never guesses. The client only reads + trims.
  - **Boundary:** this is a thin additive forward of one field. No engine / `/v1` / server change (the 0022 server already accepts the field, `extra="ignore"`). Claude Code (the first-party host) is wired via the same `@budgetary/mcp` path it already uses; third-party hosts and the hosted `/mcp` endpoint are unchanged (they keep `language = (none)`).

### Patch Changes

- 6f5810a: Expose the package-runner tool (`npx`/`pnpm dlx`/`yarn dlx`/`bunx`) in a step's redacted `target` so server-side test/quality classification works for runner-invoked tooling.

  - **MCP:** the 0019d shell-target redactor gains one more allowlisted-second-token branch. For a package-runner preamble — `npx <tool>`, `bunx <tool>`, `pnpm dlx <tool>`, `yarn dlx <tool>` — the tool that actually runs is exposed as the cleartext second token **iff it is in a fixed runner allowlist** (`jest`, `vitest`, `mocha`, `ava`, `tap`, `jasmine`, `karma`, `cypress`, `playwright`, `tsc`, `eslint`, `biome`, `nyc`, `c8`). So `npx jest …` → `"npx jest <digest>"` and `pnpm dlx playwright test …` → `"pnpm playwright <digest>"`, giving the server (0019c-2) the generic-shell second-token signal it already classifies.
  - **Leak-safety:** membership in the runner allowlist — never a charset — is the gate. A non-allowlisted/private package (`npx my-private-cli`, `npx @acme/secret-codegen`) stays inside the digest and degrades to the bare preamble program (`"npx <digest>"`), exactly today's behavior → server returns `other`. Formatters (`prettier`) are deliberately excluded: formatting is not verification.
  - **Boundary unchanged:** the client still classifies nothing (it forwards a program name + digest; the server labels the phase). Same digest-over-the-whole-normalized-command retry key, same fail-closed posture, same `BUDGETARY_TRACE_TARGET=off` opt-out. Claude Code only; Codex deferred; third-party hosts unchanged. No SDK/`/v1`/engine change.

- Updated dependencies [8c3fc92]
- Updated dependencies [018d606]
- Updated dependencies [e986b70]
  - @budgetary/sdk@0.2.0

## 0.1.1

### Patch Changes

- 15ba2da: Add the `mcpName` field linking `@budgetary/mcp` to its MCP server-registry entry (`io.github.thriftell/budgetary`).

  Listing/metadata only — no tool, runtime, or API behavior change. The MCP registry verifies npm-package ownership by reading `mcpName` from the published tarball, and the already-published `0.1.0` predates the field, so this patch republishes the same server as `0.1.1` with the linking field present.

## 0.1.0

### Minor Changes

- First published release (0.1.0).

  - `@budgetary/sdk` and `@budgetary/mcp` ship to npm with build provenance.
    The SDK publishes a dual ESM + CommonJS build (both `import` and `require`
    resolve the public API); the MCP server ships its `budgetary-mcp` bin.
  - `budgetary-vscode` is published to Open VSX.

  No package behaviour changes — this release wires up distribution only.

### Patch Changes

- Updated dependencies
  - @budgetary/sdk@0.1.0
