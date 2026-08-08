---
"@budgetary/mcp": patch
---

Show the hook-less install notice even when an estimate returns no forecast.

The one-time notice — that nothing on this install is submitting your finished runs, and how to change that — was withheld whenever an estimate came back without a forecast. That coupled two unrelated things. Whether a run's real token counts can be submitted is a property of how the install is wired; whether a forecast could be made is a property of the query. The client already draws that distinction where it matters most — a query with no forecast is still recorded locally, precisely so its real counts can be submitted later — and the notice is about exactly that submission path, so it no longer waits for a priced estimate to appear.

It is appended beneath the message, never in place of it. An estimate that returns no forecast says what it always said, byte for byte, and the block follows under a separator.

Nothing else moved:

- The notice still appears **once per install**, and the marker recording that is still claimed last — an install that would not have been shown the notice does not silently spend it.
- The conditions that suppress it are unchanged. An install with an automatic path — the plugin's declaration, or any session-end run that has actually happened here — sees nothing new, on any estimate.
- The wording needed no change. A run whose query could not be forecast is stored and submitted by the same two routes as any other, so "nothing will submit this run's real token counts when it finishes" is as true there as anywhere.
- `estimate` remains the only model-invokable tool, and no path accepts a model-supplied token count.

`npx @budgetary/mcp doctor` still reports the same state on demand, whenever you ask it.
