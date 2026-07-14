---
"@budgetary/mcp": minor
---

Attribute an actual to the run that produced it, via an opaque provenance tag.

`POST /v1/actuals` now carries `metadata: { source }`. The tag is **declared in the
environment** (`BUDGETARY_SOURCE`) and resolved exactly ONCE — at estimate time, where
the pending entry is created, beside the forecast band. It is persisted on that entry,
and the submit path reads it back from the entry; it never consults `process.env`.

That indirection is the whole point. The actuals path is cross-session and
cross-process: the estimate runs in the MCP server, the submit in a separate
`SessionEnd` hook, and a **failed submit is queued to `~/.budgetary/pending.json` and
retried by some later session under whatever environment that session happens to have**.
Resolving the tag at submit time would therefore either drop the run's real tag (a
retrying session has no variable set) or, worse, stamp the retrying session's tag onto
another run's actual — a silent mislabel. The tag is a property of the RUN, so it
travels with the run's entry. `source` is the same class of signal as `language`: never
a model-writable tool argument, never inferred from the task.

Defaults to `mcp_client` when unset, and **fails open** — an absent, blank, over-long
(> 64 chars), or malformed value resolves to that default rather than failing a submit
or being written to the store (`metadata` is 2 KB-capped server-side as a `413`, so an
unbounded value could turn a real contribution into a rejected request). The client
validates the tag's SHAPE only and forwards it as an opaque string; it encodes no
vocabulary, so the tag changes nothing about how a user's data is handled.

Also fixes `report-actual --estimate-id <id>`, which built a synthetic entry without ever
consulting the store. When a real pending row existed for that id it would submit the
default tag and then *delete* the row that held the real one — losing it silently. It now
prefers the real row when one matches (falling back to the synthetic placeholder only for
its original purpose: an estimate that was billed but whose local row was never written),
which also means a by-id close now prints the same `Forecast check:` line as every other
path.

Store: `PendingEntry.source` is additive and v1-compatible (re-validated at read time,
so no file `version` bump). No SDK change — `ActualsRequest.metadata` already existed
and is already forwarded verbatim.
