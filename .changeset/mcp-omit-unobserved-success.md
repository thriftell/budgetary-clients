---
"@budgetary/mcp": minor
---

Stop reporting a run outcome nobody measured — the four submit paths now send
`success` only when something observed it.

`POST /v1/actuals` used to require a boolean `success`: *whether the agent run
completed its objective*. That is a fact about the **run**, and this client had
four submit paths, none of which could decline to answer and none of which
observed the answer it gave. The contract has since made the field optional,
with absent meaning *the outcome was not observed* — neither a failure nor a
success — so declining is now possible, and this release does it.

The rule that decides every case: **a path that did not observe the outcome
sends nothing.** Never a default in either direction — recording an unobserved
run as succeeded biases every downstream read toward success, recording it as
failed does the mirror-image damage, and neither is recoverable: the endpoint is
idempotent per estimate, only the first stored submission's value is kept, and
there is no update call.

- ⚠️ **Behavior change — `on-session-end --transcript` no longer defaults to
  success.** The parser initialized `success = true`, so a **flag-less
  invocation silently recorded a success it had not measured**. It now records
  nothing unless `--success` or `--failed` is passed. `--success`/`--failed`
  themselves are unchanged and forwarded verbatim — a harness invoking this
  subcommand is declaring what its own oracle measured, and it is the one
  honest producer of this field. A body built **with** an explicit flag is
  byte-identical to before, pinned against the exact serialized bytes. If you
  script this command and relied on the old default, pass `--success`
  explicitly.
- **`report-actual` now asks a question you can decline.** The old prompt was
  `Did the task succeed? [y/N]`, which mapped an **empty answer to `false`** —
  a person who did not know, or did not want to say, was recorded as reporting
  a failed run. It is now three-state (*yes / no / not sure*), an empty answer
  selects *not sure*, and *not sure* omits the field. Nothing is pre-selected.
  An explicit yes/no still sends exactly `true`/`false`. And an
  uninterpretable answer no longer aborts the whole command: previously it
  exited non-zero and threw away the token counts you had just typed in, which
  were measured and are now kept.
- **The SessionEnd hook path sends nothing, permanently.** It derived the
  outcome from the host's session-close `reason`, which is **session**-scoped
  (how the window closed) while `success` is **run**-scoped (how the task
  turned out) — and a session holds many runs. No member of the enum names an
  outcome, `other` is the host's own default parameter value covering crashes
  and clean shutdowns indistinguishably, and a task that simply finishes never
  fires this hook at all. The reason→outcome helper is deleted rather than
  narrowed: every remapping is the same category error with different victims.
  Pinned by test across all six reason values.
- **The in-process reconcile sends nothing, permanently.** It runs in a later
  session against a previous session's entry, and its gates prove only that the
  earlier session **ended** — never that the task **worked**. Its hardcoded
  `success: true` is gone; the test that pinned the constant now pins the
  absence.
- **Absence survives the retry ladder.** The round-trip that persists a failed
  submit's counts and resubmits them from a later session previously *required*
  a boolean, so an absence would have read as corruption — and the obvious fix
  quietly persists `false`. A persisted absence and a persisted explicit value
  now each survive to the attempt that actually stores the row, tested
  separately. The run whose first submit failed is the run most likely to have
  an interesting outcome; it is exactly the wrong row to mislabel.

Two of the four paths send nothing from now on. That is the designed outcome,
not a gap: they are not measuring instruments for this fact. The token counts
they *do* measure submit exactly as before — an unobserved outcome never costs
a submission. `estimate` remains the only model-invokable tool, its schema is
unchanged, and no model-callable path can declare a run's outcome.
