---
"budgetary-vscode": patch
---

Dashboard: show the measurement the server already returns, and stop the README
telling its own listing page the extension isn't published.

- **Measured column.** The server's phase breakdown of a run's realized spend —
  `exploration`, `generation`, `testing`, `retries`, `other` — each with its
  share, plus the measured token total the breakdown covers. Every phase name is
  the payload's own key and every share is that phase's `share` with its unit
  changed; nothing is dropped, merged or reordered by size.
- **Normal? column.** The server's `verdict` on where the realized total landed
  against that run's own predicted interval, printed exactly as received, with
  the `efficiency` label beneath it when the server returned one. An
  unrecognized value is printed as received too — never folded into a known one.
- **Absence is silence.** A field the server did not send (`undefined`) and a
  field it sent with nothing to give (`null`) both render an em-dash. The
  extension computes no breakdown and infers no verdict, so an older deployment
  that returns neither simply shows two em-dash columns.
- **`insufficient_data` is rendered like any other verdict** — same markup, same
  weight, no error styling and no warning glyph. It is the honest answer to "was
  that normal for a task like this?", and the measured breakdown in the cell
  beside it is exact whether or not there was a basis to compare against. No
  verdict is colored by severity: ranking these values against each other would
  be a judgment the API never sent.
- **README.** The published listing's install section said "The extension isn't
  yet on the Marketplace" while sitting on its own Open VSX listing page. It now
  gives the real install path (`budgetary.budgetary-vscode` on Open VSX) and
  keeps the local-development instructions under their own heading. The
  api-contract and license links were relative and packaged into dead
  `blob/HEAD/../../` URLs; they are absolute now.
