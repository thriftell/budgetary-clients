import type { LedgerEntry, Phases } from "@budgetary/sdk";

import {
  escapeHtml,
  formatShare,
  formatTimestamp,
  formatTokens,
  truncateEstimateId,
} from "../format";
import { scenarioLabel } from "./scenario";

const QUERY_MAX = 48;

/**
 * The five behavior phases, in the order the server's breakdown declares them.
 * This is the shape of the payload, not a client ranking — nothing here decides
 * which phase matters, and none is ever dropped, merged or reordered by size.
 */
const PHASE_KEYS = [
  "exploration",
  "generation",
  "testing",
  "retries",
  "other",
] as const satisfies readonly (keyof Phases)[];

function resultCell(entry: LedgerEntry): string {
  // A void / out-of-domain estimate has no prediction and will NEVER receive an
  // actual, so "○ pending" is a lie — it implies a measurement is still coming.
  // Say "no prediction" so the row reads as terminal, not stuck.
  if (entry.scenario === "out_of_domain") {
    return `<span aria-label="no prediction">no prediction</span>`;
  }
  // A glyph with an accessible label, so a screen reader announces the outcome
  // instead of an ambiguous symbol.
  if (entry.actual === null) return `<span aria-label="pending">○</span>`;
  // THREE states, not two. `success` is an observation, and `null` means nobody
  // observed one — which is neither a success nor a failure. A truthy check
  // here would print ✗ and tell the reader the run FAILED on the strength of a
  // measurement that was never taken. Compared against the literals so a future
  // wire value this client doesn't know also lands on "—" rather than silently
  // joining one of the two verdicts. Distinct from the ○ above: that row is
  // still waiting for an actual, this one has its actual and no verdict in it.
  if (entry.actual.success === true) {
    return `<span aria-label="succeeded">✓</span>`;
  }
  if (entry.actual.success === false) {
    return `<span aria-label="failed">✗</span>`;
  }
  return `<span aria-label="outcome not reported">—</span>`;
}

function predictedCell(entry: LedgerEntry): string {
  if (!entry.predicted) return "—";
  return formatTokens(entry.predicted.p50);
}

function rangeCell(entry: LedgerEntry): string {
  if (!entry.predicted) return "—";
  const { p10, p90 } = entry.predicted;
  if (!Number.isFinite(p10) || !Number.isFinite(p90) || p10 <= 0 || p90 <= 0) {
    return "—";
  }
  // Order defensively so odd wire data never renders an inverted range (the
  // chart clamps the same way).
  return `${formatTokens(Math.min(p10, p90))}–${formatTokens(Math.max(p10, p90))}`;
}

function actualCell(entry: LedgerEntry): string {
  if (entry.actual === null) return "—";
  return formatTokens(entry.actual.total);
}

/**
 * The MEASURED column: where this run's realized spend actually went, as the
 * server broke it down. Every token printed here is a server field — the five
 * phase names are the payload's own keys, each share is `phases[name].share`
 * with its unit changed, and the second line is `phases.totalTokens`.
 *
 * Two absent states, one rendering: `undefined` (the deployment didn't send the
 * field) and `null` (it sent one and had no breakdown to give — no trace was
 * forwarded) both render an em-dash. Neither is a licence to compute a
 * breakdown here; a measurement the server didn't make is silence, not a guess.
 */
function measuredCell(entry: LedgerEntry): string {
  const phases = entry.phases;
  if (phases === null || phases === undefined) return "—";
  // `?.` so a slice missing from a malformed payload degrades to that phase's
  // own em-dash instead of throwing the whole dashboard into the error view.
  const list = PHASE_KEYS.map(
    (key) => `${key} ${formatShare(phases[key]?.share)}`,
  ).join(" · ");
  // Escaped, not because a phase name can carry markup (they are our literals)
  // but because formatShare can legitimately emit "<1%".
  return `<span class="b-phase-list">${escapeHtml(list)}</span><span class="b-phase-total">${formatTokens(
    phases.totalTokens,
  )} tokens measured</span>`;
}

/**
 * The server's raw verdict for this entry, or `null` when there is none to show.
 * The single source of truth for both the cell and its class hook, so the two
 * can never disagree about whether a verdict exists.
 *
 * Typed as a string and guarded anyway: a malformed payload must read as honest
 * silence — exactly like a non-finite p10/p90 collapses the range cell — never
 * throw the whole dashboard into the error view.
 */
function rawVerdict(entry: LedgerEntry): string | null {
  const verdict = entry.assessment?.verdict;
  return typeof verdict === "string" && verdict.length > 0 ? verdict : null;
}

/**
 * The NORMAL? column: the server's verdict on where this run's realized total
 * landed against its own predicted interval, printed exactly as received — no
 * client label, no folding of an unrecognized value into a known one, no
 * threshold recomputed here. Beneath it, the efficiency label when the server
 * returned one (it can only exist where a trace was forwarded).
 *
 * `insufficient_data` is deliberately styled like every other verdict. It is
 * the honest answer to "was that normal for a task like this?", not a failure
 * and not a partial result, and the measured breakdown in the cell beside it is
 * exact regardless. Nothing in this column is colored by severity either:
 * painting one verdict red and dimming another would rank them against each
 * other — a judgment the server never sent, and one that would make the honest
 * answer read as an error. No verdict value is written down anywhere in this
 * file for the same reason; there is nothing here to keep in sync with the
 * server's vocabulary.
 */
function verdictCell(entry: LedgerEntry): string {
  const verdict = rawVerdict(entry);
  if (verdict === null) return "—";
  // `efficiency` is null when no trace was forwarded — composition cannot be
  // inferred without measured steps, so its absence is silence.
  const label = entry.assessment?.efficiency?.label;
  const efficiencyLine =
    typeof label === "string" && label.length > 0
      ? `<span class="b-efficiency">${escapeHtml(label)}</span>`
      : "";
  return `<span class="b-verdict">${escapeHtml(verdict)}</span>${efficiencyLine}`;
}

function queryCell(entry: LedgerEntry): string {
  const q = entry.queryExcerpt ?? "";
  if (q.length === 0) return "—";
  const shown = q.length > QUERY_MAX ? `${q.slice(0, QUERY_MAX)}…` : q;
  return escapeHtml(shown);
}

function row(entry: LedgerEntry): string {
  const id = escapeHtml(truncateEstimateId(entry.estimateId, 12));
  // Humanized scenario for display; the raw value stays in the class hook.
  const scenario = escapeHtml(scenarioLabel(entry.scenario));
  // Same convention as the scenario column: the RAW server verdict is the class
  // hook. No hook at all when there is no verdict — an absent field must not
  // acquire a name here.
  const verdict = rawVerdict(entry);
  const verdictClass = verdict === null ? "" : ` b-verdict-${escapeHtml(verdict)}`;
  return `<tr>
    <td class="b-cell-when">${escapeHtml(formatTimestamp(entry.createdAt))}</td>
    <td class="b-cell-query">${queryCell(entry)}</td>
    <td class="b-cell-id">${id}</td>
    <td class="b-cell-num">${predictedCell(entry)}</td>
    <td class="b-cell-num">${rangeCell(entry)}</td>
    <td class="b-cell-num">${actualCell(entry)}</td>
    <td class="b-cell-measured">${measuredCell(entry)}</td>
    <td class="b-cell-verdict${verdictClass}">${verdictCell(entry)}</td>
    <td class="b-cell-scenario b-scenario-${escapeHtml(entry.scenario)}">${scenario}</td>
    <td class="b-cell-done">${resultCell(entry)}</td>
  </tr>`;
}

export function renderRecentTable(
  entries: readonly LedgerEntry[],
  opts: { hasMore?: boolean } = {},
): string {
  if (entries.length === 0) {
    return `<p class="b-empty">No estimates yet.</p>`;
  }

  // Newest first by createdAt; entries already returned in this order from
  // the API, but sort defensively in case of future changes. An unparseable
  // date maps to -Infinity (sorts last) so the comparator stays transitive —
  // returning 0 for any unparseable pairing broke the total order.
  const ts = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : -Infinity;
  };
  const sorted = [...entries].sort((a, b) => {
    const ta = ts(a.createdAt);
    const tb = ts(b.createdAt);
    return ta === tb ? 0 : tb - ta;
  });

  // Honest about the window: key the note on whether the server reported MORE
  // pages (`hasMore`, i.e. a non-null next cursor) AND the actual rendered count —
  // not a hardcoded 50, which was wrong at both boundaries (a full-but-final page
  // claimed more existed; a load-more'd view of 120 still said "50"). When there
  // is genuinely more history the user hasn't loaded, say so with the true count.
  const capNote = opts.hasMore
    ? ` Showing the ${sorted.length} most recent — older history isn't loaded (use “Load older”).`
    : "";

  return `<table class="b-table">
  <caption class="b-caption">Recent estimates — predicted vs. actual, newest first. Measured and Normal? are reported by the server; an em-dash means it reported none.${capNote}</caption>
  <thead>
    <tr>
      <th scope="col">When</th>
      <th scope="col">Query</th>
      <th scope="col">Estimate</th>
      <th scope="col" class="b-cell-num">Predicted p50</th>
      <th scope="col" class="b-cell-num">Range (p10–p90)</th>
      <th scope="col" class="b-cell-num">Actual</th>
      <th scope="col">Measured</th>
      <th scope="col">Normal?</th>
      <th scope="col">Scenario</th>
      <th scope="col">Result</th>
    </tr>
  </thead>
  <tbody>
    ${sorted.map(row).join("\n    ")}
  </tbody>
</table>`;
}
