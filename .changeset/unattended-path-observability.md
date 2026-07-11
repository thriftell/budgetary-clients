---
"@budgetary/mcp": minor
---

Make the unattended session-end path observable. The auto actuals hook (where
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
  and the *reason* each no-op returned) — never the key value. Off by default;
  stdout stays the pure JSON-RPC channel.
- **Transcript failures are named.** A new `transcriptUnreadableReason` re-derives
  why a transcript yielded no counts (missing / non-regular / over-cap / empty /
  unrecognized format) so a Claude Code transcript-format change is diagnosable
  under the flag instead of silently killing every future submission.
- **`pending` surfaces it.** A one-line header reports the last automatic run
  ("Last automatic submission: submitted (est_…), 3h ago" or an interrupted-run
  note), so an empty queue is explained rather than merely blank.
