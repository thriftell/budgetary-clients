---
"@budgetary/mcp": patch
---

Show a recorded run's measured breakdown, instead of throwing it away.

Every submitted actual comes back with the API's measured read of that run — a
breakdown of where its tokens actually went (`exploration`, `generation`,
`testing`, `retries`, `other`, each with its share of the measured total) and its
answer to *"was that normal for a task like this?"*. The client `await`ed that
response and discarded it, so nothing a user could see ever mentioned it.

It is now captured and shown.

- **Captured in the one shared submit helper**, so all three submit paths gain it
  at once: the session-end hook, the hand-run `report-actual` /
  `on-session-end --transcript`, and the in-process reconcile that closes out a
  finished session on a later estimate.
- **Shown immediately on the hand-run commands**, beneath the submit
  confirmation — that output is the user's own terminal. Where the API returned a
  verdict, the client's own `Forecast check:` line is dropped for that submit:
  the two answered the same question from two sources, and the reported one wins.
- **Shown beneath the next `estimate`** for a run submitted by the hook, because
  a hook's output never reaches the user — the host writes it to a debug log. The
  summary is buffered locally and appears at the next estimate, void or priced,
  stamped with the id of the run it measures. Once, and never repeated.
- **Buffered in its own file** (`~/.budgetary/measured.json`), written with the
  same atomic temp+rename as everything else under that directory, capped at a
  handful of recent records, dropped after a week, and re-validated on read. It
  is deliberately NOT in `pending.json`: that store's loader rebuilds its file
  from a fixed shape and drops unrecognised keys on every write-back, so a
  summary parked there would vanish with no error. Nothing here can affect a
  pending calibration pair.

**Nothing on screen is computed by this client.** Every phase name is the
payload's own key, every percentage is that field's share with its unit changed,
the total is the reported measured total, and the verdict, its note and the
composition label are printed exactly as received — an unrecognized value
included. There is no threshold, no bucket and no fallback label anywhere: a
field the API did not send produces no line at all, never a guess and never an
em-dash standing in for one. `insufficient_data` renders like any other verdict —
same shape, same weight, no error framing — because it is the honest answer to
the question, and the measured breakdown beside it is exact regardless.

Ordering is proven by rendering the whole thing, not by reasoning about it: the
estimate's own output first (including everything a void appends), then the
summary, then the one-time hook-less notice, which stays visually last exactly as
it ships today. A void's first 149 bytes remain byte-identical.

Safe ahead of any deployment: a response without the measurement captures nothing
and renders nothing, with no version check anywhere. The tool description's final
clause no longer claims the tool never reports what a run used — it keeps the
live-usage disclaimer and makes the post-hoc half conditional on the recording
having happened. `estimate` remains the only model-invokable tool, and no path
accepts a model-supplied token count.
