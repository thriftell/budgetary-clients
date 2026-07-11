---
"@budgetary/mcp": minor
---

Pair each cross-session actuals retry with the RIGHT data, so a later session's
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
