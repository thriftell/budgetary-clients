---
"@budgetary/mcp": minor
---

Send how the run ended — from the two paths that can actually observe it, and
deliberately from no other.

The API contract has long specified an optional `censoring` field on
`POST /v1/actuals`: a closed four-value run-termination category (`natural` |
`harness_watchdog` | `operative_cap` | `kill_switch`), measured harness- or
client-side, omitted rather than guessed. No client path could send it. And it
cannot be repaired later: the endpoint is idempotent per estimate, only the
first stored submission's value is kept, and the field surfaces on no read
endpoint — so an actual submitted without it records *unknown* forever.

The rule that decides every case: **a path that cannot verify a category sends
nothing.** Never `natural` by default — an unobserved ending recorded as a
normal completion is an affirmative false claim, and it biases spend data
toward short runs, because the runs a cap stops are the long ones.

- **`on-session-end --transcript` gains `--censoring <value>`.** The invoking
  harness spawned the host, owns its watchdog, and reads the host's own result
  output — it already declares `--success`/`--failed`, and this is the same
  kind of declaration about the same run. The value is matched EXACTLY against
  the four contract literals and forwarded verbatim; anything else (a typo, a
  case variant, a fifth word) is omitted from the body — never normalized,
  never defaulted, never an error that fails the submit. Absent flag ⇒ a body
  byte-identical to before, proven by test.
- **`report-actual` now asks how the run ended** — four categories in plain
  language plus an explicit *not sure / prefer not to say*, which an EMPTY
  answer selects. Nothing is pre-selected, and a skipped question omits the
  field entirely (a new prompt helper: the existing optional-number prompt
  sends `0` on an empty answer, which is exactly the absence-read-as-a-value
  this field cannot survive).
- **The declaration survives the retry ladder.** A failed submit persists it
  beside the measured counts, and the retry — which is the first submission
  that actually stores the row — resubmits it. A killed run is precisely the
  run most likely to have had its first submit fail.
- **The SessionEnd hook path sends nothing, permanently.** Its payload `reason`
  describes how the *session* ended, not how the *run* ended — a `/clear`
  after a task finished perfectly is a person tidying up, not a kill switch —
  and no reason value names a cap. Pinned by test across all six reason
  values.
- **The in-process reconcile sends nothing, permanently.** It runs on a later
  estimate, in a different process, against a previous session's entry; it
  observed nothing about that run's ending. Pinned by test.
- **`cap_ms` / `cap_tokens` are never sent, by any path, from any source.** The
  host exposes no per-run cap to a child process or hook, and the one side
  channel that sometimes carries one is off-limits: in headless mode a host's
  command line contains the user's prompt, and reading another process's argv
  to learn a cap would mean reading that. Pinned by test on every body the
  client builds.

`estimate` remains the only model-invokable tool, its schema is unchanged, and
no model-supplied value can reach any of these fields — a model's account of
its own truncation is not a measurement.
