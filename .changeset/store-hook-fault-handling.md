---
"@budgetary/mcp": patch
---

Harden the pending-store read/write surface so an environmental fault degrades
instead of corrupting the queue or crashing the session-end hook.

- **Never clobber an unreadable queue.** `PendingStore` no longer pre-checks the
  file with `existsSync` (which returns `false` for *any* error — a lost read
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
