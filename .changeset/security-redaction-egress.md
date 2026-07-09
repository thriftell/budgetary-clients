---
"@budgetary/mcp": patch
---

Harden the execution-trace redaction so nothing sensitive can reach the wire in the clear.

- **Program name is now allowlist-gated, not charset-gated.** A shell step's cleartext program is exposed only when it is on a fixed allowlist of common, non-sensitive tools (`pytest`, `npm`, `go`, `git`, …). A pasted credential (`ghp_…`, `sk-…`), a private script name (`rotate_prod_keys.sh`), or any other free-form first token now degrades to a bare digest with no cleartext. Also caps the program length and rejects known secret prefixes as belt-and-suspenders.
- **Digests are now salted (non-reversible).** Redaction digests use HMAC-SHA256 instead of a plain truncated SHA-256. The trace `target` digest uses a fresh per-submission salt (retry-equality still holds within one submission); `project_id` uses a machine-local install salt persisted at `~/.budgetary/install-salt` (owner-only), so it stays stable per install while the salt-less server cannot dictionary-reverse it back to a path or command. The salts never leave the machine.
- **Env-assignment peel fails closed on a backslash.** A leading `VAR=val` whose value ends in a backslash (an escaped space / line-continuation) no longer splits mid-value and surfaces a later token as the program.
- **Tool names are allowlisted.** Custom/internal MCP tool names (e.g. an org-private `mcp__acme__…`) are bucketed to `mcp:other` instead of being forwarded verbatim.
- **Trace-target opt-out fails safe.** `BUDGETARY_TRACE_TARGET` now stays ON only for an explicit affirmative (`1`/`true`/`on`/`yes`) or the unset/blank default; any other value (including a typo like `disabled`) resolves to OFF.
- **Build cleans `dist` first** so a stale artifact can't ship on a local publish.

Behavior deltas (mainline unchanged): a normal command's `target` is identical except its digest is now salted; a first token that is not an allowlisted program is emitted as a bare digest rather than in the clear; `project_id` becomes a per-install salted value (a one-time regrouping of a user's historical ledger); an unrecognized `BUDGETARY_TRACE_TARGET` value now disables the descriptor instead of leaving it on. README and the API contract no longer overclaim an unsalted digest as "non-reversible".
