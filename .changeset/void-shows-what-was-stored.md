---
"@budgetary/mcp": patch
---

Tell the user what happened when an estimate returns no forecast.

Until now that answer was two sentences and a full stop: we cannot estimate this
one, it was not billed, proceed at your own judgment. Everything else the client
had to say was skipped — including the fact that it had just stored a pending
entry for the run on the user's behalf, and that the run is closeable like any
other. A query with no forecast is exactly the one whose real counts are most
worth recording, and the surface that could ask for them said nothing.

It now says three more things, appended beneath the message:

- **the estimate id**, in the same short form the priced footer, `pending` and the
  submit confirmation already print, so the render, the local entry and the
  eventual submission all correlate by eye;
- **the host's existing "what happens next" lines** — the same ones a priced
  estimate ends with, produced by the same code, because the next step is
  identical: neither route to recording a run's actuals needs a forecast band;
- **one sentence on what recording returns**: when this run's token counts are
  recorded, its measured breakdown appears here. A breakdown of a finished run's
  own counts is a measurement, so it is exact and needs nothing to compare
  against — which is why it can be promised beneath a query we could not forecast.
  It is not a forecast, not a timeline, and not a judgement about the run.

The message itself did not move. Its first 149 bytes are byte-identical to what
shipped before, proven by a test that compares them against a transcribed literal
rather than by a substring match; every addition is an append after a blank line.
The one-time hook-less install notice still renders last, beneath all of it, and
the priced estimate is byte-for-byte unchanged — also pinned by tests, host by
host.

Two things deliberately unchanged. An estimate whose pending entry could not be
saved still renders exactly what it rendered before: the copy for that state is
written for a billed estimate, which this one is not, and printing both claims
would put a contradiction on screen. And `estimate` remains the only
model-invokable tool — nothing here adds a tool, and no path accepts a
model-supplied token count.
