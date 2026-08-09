import { describe, expect, it } from "vitest";
import type { EstimateResponse } from "@budgetary/sdk";

import {
  forecastOnly,
  forecastVsActual,
  renderAuthFailed,
  renderEstimate,
  renderPermissionDenied,
  renderRateLimited,
  renderTransportError,
  shortEstimateId,
} from "../src/format.js";

function estimate(overrides: Partial<EstimateResponse> = {}): EstimateResponse {
  return {
    estimateId: "est_1",
    scenario: "confident",
    void: false,
    distribution: { p10: 12500, p50: 48000, p90: 220000, unit: "tokens" },
    confidence: 0.8,
    model: "claude-opus-4-7",
    expiresAt: "2026-05-27T10:14:00Z",
    ...overrides,
  };
}

describe("renderEstimate — honest presentation", () => {
  it("confident: leads with the point but always shows the range and a decoded confidence", () => {
    const text = renderEstimate(estimate({ scenario: "confident", confidence: 0.8 }));
    expect(text).toContain("Estimated cost:");
    expect(text).toContain("12,500–220,000"); // the band is visible
    expect(text).toContain("p10–p90");
    expect(text).toContain("Scenario: confident");
    expect(text).toContain("Confidence: 0.80 (high)");
    // No caution / range-led framing for a confident estimate.
    expect(text).not.toContain("⚠");
    expect(text).not.toContain("Estimated range:");
  });

  it("uncertain: leads with the RANGE + a caution, and differs from a confident render", () => {
    const uncertain = renderEstimate(estimate({ scenario: "uncertain", confidence: 0.35 }));
    const confident = renderEstimate(estimate({ scenario: "confident", confidence: 0.9 }));
    expect(uncertain).toContain("Estimated range:");
    expect(uncertain).toContain("⚠");
    expect(uncertain).toContain("Wide range");
    expect(uncertain).toContain("Confidence: 0.35 (low)");
    // A low-confidence estimate must not render like a confident precise one.
    expect(uncertain).not.toEqual(confident);
    expect(uncertain).not.toContain("Estimated cost:");
  });

  it("a 'confident' scenario with LOW confidence leads with the range (honesty override)", () => {
    // scenario and confidence are independent on the wire; the two signals must
    // never disagree on screen.
    const text = renderEstimate(estimate({ scenario: "confident", confidence: 0.2 }));
    expect(text).toContain("Estimated range:");
    expect(text).toContain("⚠");
    expect(text).toContain("Low confidence");
    expect(text).toContain("Confidence: 0.20 (very low)");
    expect(text).not.toContain("Estimated cost:");
    expect(text).not.toContain("the range is reliable");
  });

  it("sparse_evidence: leads with the range and its own caution", () => {
    const text = renderEstimate(estimate({ scenario: "sparse_evidence" }));
    expect(text).toContain("Estimated range:");
    expect(text).toContain("⚠");
    expect(text).toContain("sparse evidence");
  });

  it("an unknown/future scenario degrades to the uncertain (range-led) presentation", () => {
    const text = renderEstimate(estimate({ scenario: "brand_new_label" }));
    expect(text).toContain("Estimated range:");
    expect(text).toContain("⚠");
    expect(text.toLowerCase()).toContain("uncertain");
    // The raw unknown label is not presented as a confident scenario.
    expect(text).not.toContain("Estimated cost:");
  });

  it("void: says it wasn't billed (not 'No charge') and renders no numbers", () => {
    const text = renderEstimate(
      estimate({ scenario: "out_of_domain", void: true, distribution: null, confidence: 0 }),
    );
    expect(text).toContain("No forecast for this task");
    expect(text).toContain("wasn't billed");
    expect(text).not.toContain("No charge");
    // 0026b-2: the abstention is stated as an answer, not as a shortfall of
    // ours, and the engine's own scenario label is gone from the copy.
    expect(text).toContain("an abstention is an answer, not an error");
    expect(text).not.toContain("cannot confidently estimate");
    expect(text).not.toContain("out of domain");
    // Still not a single forecast number: no band, no midpoint, no worst case,
    // no confidence decimal. What 0026c appended beneath it is prose about the
    // pending entry — nothing derived from a distribution that does not exist.
    expect(text).not.toContain("Estimated");
    expect(text).not.toContain("Worst case");
    expect(text).not.toContain("Confidence:");
    expect(text).not.toContain("p10");
  });

  it("clamps a malformed confidence into [0,1] rather than printing a raw decimal", () => {
    expect(renderEstimate(estimate({ confidence: 1.5 }))).toContain("Confidence: 1.00 (high)");
    expect(renderEstimate(estimate({ confidence: Number.NaN }))).toContain("(very low)");
  });
});

// ---------------------------------------------------------------------------
// 0026c — the void moment. What is APPENDED beneath a message that may not move.
// ---------------------------------------------------------------------------

/**
 * A void estimate's own message, verbatim and TRANSCRIBED — deliberately not
 * computed from `renderEstimate`, which is the function under test: an
 * expectation derived from the code under test passes whatever that code becomes.
 *
 * 0026b-2 rewrote it. What 0026c appends beneath it, and the blank-line seam
 * between the two, are untouched — so a change to either side still fails here,
 * loudly.
 */
const VOID_MESSAGE =
  "No forecast for this task — Budgetary has no firm basis to judge one like it, and won't guess.\n" +
  "This estimate wasn't billed. Proceed on your own judgment — an abstention is an answer, not an error.";

/**
 * The message's length in bytes, DERIVED from the transcribed literal above.
 *
 * ★ 0026b-2 killed the magic number. `149` used to be hardcoded eight times
 * across three files while the literal it described was transcribed three times
 * — two encodings of one fact, kept in step by hand, and the second item in a
 * row to have to chase them. Deriving it costs nothing in strength: every
 * comparison below still proves that `renderEstimate`'s OUTPUT opens with these
 * exact bytes, because the literal is transcribed rather than read off
 * `renderEstimate`. The one place the number stays hardcoded is the length test
 * immediately below, whose entire job is to measure it.
 */
const VOID_BYTES = Buffer.byteLength(VOID_MESSAGE, "utf8");

/** The sentence the append closes on, transcribed for the same reason. */
const MEASURED_FOLLOW_UP =
  "When this run's token counts are recorded, its measured breakdown appears here.";

function voidEstimate(): EstimateResponse {
  return estimate({
    estimateId: "est_01ABCDEF2345",
    scenario: "out_of_domain",
    void: true,
    distribution: null,
    confidence: 0,
  });
}

describe("renderEstimate — the void's own message, and the seam beneath it", () => {
  it("the transcribed message really is 200 UTF-8 bytes / 196 characters", () => {
    // ★ THE ONE PLACE THE NUMBER IS HARDCODED, and the reason `VOID_BYTES` may
    // be derived everywhere else: the length is MEASURED here, not asserted
    // there. If the message ever changes length these two numbers are wrong and
    // this fails first — before any prefix comparison built on `VOID_BYTES`
    // could quietly re-align itself around the new literal and start passing.
    expect(Buffer.byteLength(VOID_MESSAGE, "utf8")).toBe(200);
    expect(VOID_MESSAGE.length).toBe(196);
    // 196 characters, 200 bytes: the two em-dashes are 3 bytes each.
    expect(VOID_BYTES).toBe(200);
  });

  it("every host's void render OPENS with those exact bytes, then a blank line", () => {
    for (const host of [undefined, "claude-code", "codex", "cursor", "mcp"]) {
      const bytes = Buffer.from(
        renderEstimate(voidEstimate(), { host, stored: true }),
        "utf8",
      );
      // Byte-level equality against the literal — not `toContain`, and not a
      // character-index slice, since what is being proven is the ENCODING.
      expect(bytes.subarray(0, VOID_BYTES).toString("utf8")).toBe(VOID_MESSAGE);
      // The seam is a blank line, so nothing appended can run into the message.
      // 0026b-2 moved the literal above it; the seam itself did not move.
      expect(bytes.subarray(VOID_BYTES, VOID_BYTES + 2).toString("utf8")).toBe("\n\n");
    }
  });

  it("★ THE FOOTER SEAM, whole-output, for EVERY host (0026b-2)", () => {
    // Whole-output equality, per host — never a substring. The footer lines are
    // transcribed from the shipped copy rather than imported, so a silent edit
    // to `storedFooter` shows up here as a diff instead of passing by
    // construction.
    //
    // ★ 0026b-2 widened this from three hosts to all FIVE. The message above the
    // seam moved, so "the seam did not move" has to be re-proven rather than
    // assumed, and `undefined` and `cursor` — the two that had no golden — are
    // exactly the paths a footer regression would hide in.
    //
    // Note the SINGLE newline before the follow-up, where every other join here
    // is a blank line. That is shipped behaviour and it must not drift: those
    // footer lines say how the counts get recorded, and the follow-up continues
    // the same thought by saying what recording them returns.
    const CC_FOOTER = [
      "Pending estimate stored. With the Budgetary plugin installed, actuals are",
      "recorded automatically at session end — otherwise run `npx @budgetary/mcp report-actual`.",
    ];
    const CODEX_FOOTER = [
      "Pending estimate stored. After the run, record actuals with",
      "`npx @budgetary/mcp on-session-end --transcript <rollout>` (or `report-actual`).",
    ];
    const DEFAULT_FOOTER = [
      "Pending estimate stored. After the run, record actuals with",
      "`npx @budgetary/mcp report-actual`.",
    ];
    const footers: [string | undefined, string[]][] = [
      [undefined, DEFAULT_FOOTER],
      ["claude-code", CC_FOOTER],
      ["codex", CODEX_FOOTER],
      ["cursor", DEFAULT_FOOTER],
      ["mcp", DEFAULT_FOOTER],
    ];
    for (const [host, footer] of footers) {
      expect(renderEstimate(voidEstimate(), { host, stored: true })).toBe(
        [
          VOID_MESSAGE,
          "",
          "Estimate id: est_01ABCDEF…",
          "",
          ...footer,
          MEASURED_FOLLOW_UP,
        ].join("\n"),
      );
    }
  });

  it("prints the SHORT id — the same form the priced footer and `pending` show", () => {
    const text = renderEstimate(voidEstimate(), { stored: true });
    expect(text).toContain("Estimate id: est_01ABCDEF…");
    expect(text).not.toContain("est_01ABCDEF2345"); // truncated, never full
  });

  it("renders the message ALONE when nothing was stored", () => {
    // The un-stored footer is written for a BILLED estimate ("this estimate was
    // ALREADY billed, so do NOT re-estimate"), which the void's own second line
    // contradicts four lines above. Reusing it verbatim would print both claims
    // at once; re-authoring it would move copy this item does not own AND change
    // the priced path's bytes. So a void with no pending entry renders its
    // message and nothing else — never a footer describing an entry that isn't
    // there, and never the follow-up promise it underwrites.
    const text = renderEstimate(voidEstimate(), { host: "claude-code", stored: false });
    expect(text).toBe(VOID_MESSAGE);
    expect(text).not.toContain("ALREADY billed");
    expect(text).not.toContain(MEASURED_FOLLOW_UP);
  });

  it("renders the message ALONE when the response carried no estimate id", () => {
    // Nothing pairable was stored, so there is no id to print and no run whose
    // counts could ever be recorded against one. (The SDK validates a non-empty
    // id on every response; this pins the fail-closed behaviour if it ever isn't.)
    expect(renderEstimate(estimate({ ...voidEstimate(), estimateId: "" }))).toBe(
      VOID_MESSAGE,
    );
  });

  it("★ and the message READS COMPLETE alone — the state both fail-closed branches reach", () => {
    // ★ 0026b-2. Two branches return the message with nothing beneath it, so it
    // has to stand on its own: a reader in that state gets these two lines and
    // no other text at all. What "complete" means here is asserted rather than
    // eyeballed.
    for (const alone of [
      renderEstimate(voidEstimate(), { host: "claude-code", stored: false }),
      renderEstimate(estimate({ ...voidEstimate(), estimateId: "" })),
    ]) {
      expect(alone).toBe(VOID_MESSAGE);
      // Exactly two lines, neither empty, no trailing seam left dangling where
      // an appended block used to be.
      const lines = alone.split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
      expect(alone.endsWith("\n")).toBe(false);

      // It says what happened, what it cost, and what to do — the three things
      // a reader needs when this is all they get.
      expect(alone).toContain("No forecast for this task"); // what happened
      expect(alone).toContain("This estimate wasn't billed."); // what it cost
      expect(alone).toContain("Proceed on your own judgment"); // what to do

      // ⚠ It does NOT forward-reference anything that is not on screen. In this
      // state there is no id, no footer, and no measured follow-up beneath it,
      // so any promise of one would be a dangling reference.
      expect(alone).not.toContain("below");
      expect(alone).not.toContain("above");
      expect(alone).not.toContain("here:");
      expect(alone).not.toContain(MEASURED_FOLLOW_UP);
      expect(alone).not.toContain("measured breakdown");
      expect(alone).not.toContain("Estimate id");

      // ⚠ And it does not duplicate the measurement promise that IS appended one
      // blank line below in the stored case — the two must not read as the same
      // sentence said twice.
      const stored = renderEstimate(voidEstimate(), { host: "claude-code", stored: true });
      expect(stored.slice(VOID_MESSAGE.length)).toContain(MEASURED_FOLLOW_UP);
      expect(alone).not.toContain(MEASURED_FOLLOW_UP);

      // ⚠ No promise that a forecast is coming, and no timeline for one. An
      // abstention is the answer, not a delay before the real one.
      for (const word of ["will be", "try again", "check back", "later", "next time", "for now"]) {
        expect(alone.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("promises the MEASUREMENT — never a forecast, a timeline, or a verdict", () => {
    const s = MEASURED_FOLLOW_UP.toLowerCase();
    // A forecast is precisely what the message above said it could not give.
    for (const word of ["forecast", "predict", "estimate of", "expect"]) {
      expect(s).not.toContain(word);
    }
    // No clock: nothing here knows when, or whether, the counts are submitted.
    for (const word of ["soon", "shortly", "next time", "within", "minute", "hour", "day"]) {
      expect(s).not.toContain(word);
    }
    // No judgement about the run — that is a separate, server-computed answer.
    for (const word of ["normal", "efficient", "elevated", "anomalous", "verdict", "good", "bad"]) {
      expect(s).not.toContain(word);
    }
    // What it DOES promise.
    expect(s).toContain("measured breakdown");
  });

  it("keeps engine vocabulary, rates and commercial claims out of the WHOLE void render", () => {
    // ★ 0026b-2 widened this from `.slice(VOID_MESSAGE.length)` to the whole
    // output, because the narrow version was how `(out of domain)` survived on
    // a public string that reaches users directly: the sweep scanned only what
    // was APPENDED beneath the message, and the one banned literal that would
    // have caught it was spelled `out_of_domain` while the copy said "out of
    // domain". Both holes are closed — the scan now covers the message itself,
    // and the spaced spelling is banned alongside the underscored one.
    const whole = renderEstimate(voidEstimate(), { host: "claude-code", stored: true })
      .toLowerCase();
    // No engine vocabulary on a public surface, in either spelling.
    for (const word of [
      "coverage",
      "stability",
      "bandwidth",
      "csr",
      "neighbor",
      "out_of_domain",
      "out of domain",
      "out-of-domain",
    ]) {
      expect(whole).not.toContain(word);
    }
    // No rate, EVER — and this is the sweep that matters most now the message
    // itself is in scope. "no firm basis to judge one like it" is a statement
    // about THIS answer; the moment it acquires a frequency word it becomes a
    // claim about how much is covered, which nothing here may say.
    for (const word of [
      "usually",
      "often",
      "most ",
      "rarely",
      "typically",
      "seldom",
      "sometimes",
      "generally",
      "%",
    ]) {
      expect(whole).not.toContain(word);
    }
    expect(whole).not.toMatch(/\b\d+\s*(%|percent)/);
    // No commercial claim of any kind. "This estimate wasn't billed" is a fact
    // about ONE transaction and is deliberately not extended.
    for (const word of ["price", "pricing", "paid", "plan", "tier", "licence", "license", "enterprise", "trial", "$"]) {
      expect(whole).not.toContain(word);
    }
    // No promise that a forecast is coming — an abstention is the answer, not a
    // delay. (The measured breakdown promised beneath it is a COUNT of a run's
    // own tokens; it is not a forecast and does not contradict this.)
    for (const word of ["try again", "check back", "later", "soon", "shortly", "for now", "yet"]) {
      expect(whole).not.toContain(word);
    }
  });
});

describe("renderEstimate — the PRICED path is byte-unchanged by 0026c", () => {
  /**
   * `main`'s exact priced output, transcribed. 0026c touches only the void
   * branch, and "only" is a claim worth failing on: these four goldens are the
   * whole priced surface (three host footers plus the un-stored branch), asserted
   * as complete strings rather than by substring.
   */
  function priced(): EstimateResponse {
    return estimate({ estimateId: "est_01ABCDEF2345", confidence: 0.74 });
  }

  const HEAD = [
    "Estimated cost: ~48,000 tokens (range 12,500–220,000, p10–p90)",
    "Worst case (p90): ~220,000 tokens",
    "Scenario: confident — well-supported, the range is reliable.",
    "Confidence: 0.74 (moderate)",
    "Model: claude-opus-4-7",
    "Valid until: 2026-05-27T10:14:00Z",
    "Estimate id: est_01ABCDEF…",
  ];

  it("claude-code, with the key tier line", () => {
    expect(
      renderEstimate(priced(), { host: "claude-code", stored: true, keyPrefix: "bg_test_" }),
    ).toBe(
      [
        ...HEAD,
        "Key: bg_test_ (free)",
        "",
        "Pending estimate stored. With the Budgetary plugin installed, actuals are",
        "recorded automatically at session end — otherwise run `npx @budgetary/mcp report-actual`.",
      ].join("\n"),
    );
  });

  it("the default host", () => {
    expect(renderEstimate(priced(), { host: "mcp", stored: true })).toBe(
      [
        ...HEAD,
        "",
        "Pending estimate stored. After the run, record actuals with",
        "`npx @budgetary/mcp report-actual`.",
      ].join("\n"),
    );
  });

  it("codex", () => {
    expect(renderEstimate(priced(), { host: "codex", stored: true })).toBe(
      [
        ...HEAD,
        "",
        "Pending estimate stored. After the run, record actuals with",
        "`npx @budgetary/mcp on-session-end --transcript <rollout>` (or `report-actual`).",
      ].join("\n"),
    );
  });

  it("un-stored — the already-billed free close, untouched", () => {
    expect(renderEstimate(priced(), { host: "claude-code", stored: false })).toBe(
      [
        ...HEAD,
        "",
        "⚠ Couldn't save this as a pending estimate — the local store under ~/.budgetary",
        "  is unwritable. This estimate was ALREADY billed, so do NOT re-estimate (that",
        "  bills again). Record its actuals directly against its id — no pending row needed:",
        "    npx @budgetary/mcp report-actual --estimate-id est_01ABCDEF2345",
        "  Fix ~/.budgetary to restore automatic recording; re-estimating is a last resort.",
      ].join("\n"),
    );
  });

  it("carries no measured follow-up — that promise belongs to the void's append", () => {
    // The priced path gains nothing here. When a recorded run's summary does
    // render beneath a later estimate, a separate item owns that.
    expect(renderEstimate(priced(), { host: "claude-code", stored: true })).not.toContain(
      MEASURED_FOLLOW_UP,
    );
  });
});

describe("renderEstimate — cost-loop additions (worst case, validity, key tier)", () => {
  it("names the p90 worst case and the validity window", () => {
    const text = renderEstimate(estimate());
    expect(text).toContain("Worst case (p90): ~220,000 tokens");
    expect(text).toContain("Valid until: 2026-05-27T10:14:00Z");
  });

  it("omits the validity line when the server sent no expiresAt", () => {
    expect(renderEstimate(estimate({ expiresAt: "" }))).not.toContain("Valid until");
  });

  it("surfaces the key tier where the spend happens (paid vs free), or nothing when unknown", () => {
    expect(renderEstimate(estimate(), { keyPrefix: "bg_live_" })).toContain(
      "Key: bg_live_ (paid)",
    );
    expect(renderEstimate(estimate(), { keyPrefix: "bg_test_" })).toContain(
      "Key: bg_test_ (free)",
    );
    // Unrecognized / absent → no key line (never a fabricated tier).
    expect(renderEstimate(estimate(), { keyPrefix: "unrecognized" })).not.toContain(
      "Key:",
    );
    expect(renderEstimate(estimate())).not.toContain("Key:");
  });
});

describe("storedFooter — an un-stored (but already-billed) estimate closes for FREE", () => {
  it("prints the FULL id + report-actual --estimate-id, and does NOT lead with re-estimate", () => {
    const text = renderEstimate(estimate({ estimateId: "est_fullid_abcdef123" }), {
      stored: false,
    });
    // The FULL id (never truncated) so the free close is copy-pasteable.
    expect(text).toContain(
      "report-actual --estimate-id est_fullid_abcdef123",
    );
    // Already billed → must warn against re-estimating (a second bill).
    expect(text).toContain("ALREADY billed");
    expect(text).toContain("do NOT re-estimate");
    // Re-estimating is demoted to a last resort, not the headline fix.
    expect(text).toContain("last resort");
  });
});

describe("forecastVsActual / forecastOnly (tokens only, never a $)", () => {
  const band = { p10: 100, p50: 500, p90: 2000 };
  it("places the actual within / above / below the band", () => {
    expect(forecastVsActual(480, band)).toBe(
      "actual 480 tokens vs forecast ~500 (within p10–p90)",
    );
    expect(forecastVsActual(5000, band)).toContain("above p10–p90");
    expect(forecastVsActual(50, band)).toContain("below p10–p90");
    expect(forecastVsActual(480, band)).not.toContain("$");
  });
  it("returns null when the band is missing or partial (never a garbage line)", () => {
    expect(forecastVsActual(480, {})).toBeNull();
    expect(forecastVsActual(480, { p10: 1, p50: 2 })).toBeNull();
    expect(forecastVsActual(480, { p10: 1, p50: Number.NaN, p90: 3 })).toBeNull();
  });
  it("forecastOnly renders the band alone for an open row, or null when absent", () => {
    expect(forecastOnly(band)).toBe("forecast ~500 tokens (p10–p90 100–2,000)");
    expect(forecastOnly({})).toBeNull();
  });
});

describe("renderRateLimited — enriched with the tier window + retry ordeal", () => {
  it("surfaces the tier limit, remaining, reset, and attempts", () => {
    // Fixed clock: reset epoch 1000s, now 900s → resets in ~100s.
    const text = renderRateLimited(30, {
      requestId: "req_z",
      limit: 100,
      remaining: 0,
      resetSeconds: 1000,
      attempts: 5,
      totalElapsedMs: 240000,
      now: () => 900_000,
    });
    expect(text).toContain("Try again in 30 seconds.");
    expect(text).toContain("Tier limit: 100 requests/window, 0 left.");
    expect(text).toContain("Window resets in ~100s.");
    expect(text).toContain("after 5 attempts over 240s");
    expect(text).toContain("(request_id: req_z)");
  });
  it("degrades cleanly when the window fields are absent (no NaN, no fabricated numbers)", () => {
    const text = renderRateLimited(null);
    expect(text).toBe("Budgetary rate limit reached. Try again in a little while.");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Tier limit");
  });
});

describe("estimate_id visibility (O-4)", () => {
  it("renderEstimate shows the short estimate id, correlating with pending + submit", () => {
    const text = renderEstimate(estimate({ estimateId: "est_abcdefghijklmnop" }));
    expect(text).toContain("Estimate id: est_abcdefgh…");
    expect(text).not.toContain("est_abcdefghijklmnop"); // truncated, never full
  });

  it("shortEstimateId truncates only past 12 chars", () => {
    expect(shortEstimateId("est_short")).toBe("est_short");
    expect(shortEstimateId("est_abcdefghijklmnop")).toBe("est_abcdefgh…");
  });
});

describe("request_id threading into the auth/plan/rate-limit renderers (O-4)", () => {
  it("appends request_id when the server surfaced one, omits it otherwise", () => {
    expect(renderAuthFailed("mcp", "env", "req_a")).toContain("(request_id: req_a)");
    expect(renderAuthFailed("mcp", "env")).not.toContain("request_id");
    expect(renderAuthFailed("mcp", "env", null)).not.toContain("request_id");

    expect(renderPermissionDenied("req_b")).toContain("(request_id: req_b)");
    expect(renderPermissionDenied()).not.toContain("request_id");

    expect(renderRateLimited(5, { requestId: "req_c" })).toContain("(request_id: req_c)");
    expect(renderRateLimited(5)).not.toContain("request_id");
    expect(renderRateLimited(null, { requestId: "req_d" })).toContain(
      "(request_id: req_d)",
    );
  });
});

describe("renderTransportError — retry-ordeal visibility (O-6)", () => {
  it("shows 'after N attempts over Ns' when the SDK exhausted its ladder", () => {
    const text = renderTransportError("fetch failed", "req_1", 5, 240000);
    expect(text).toContain("after 5 attempts over 240s");
    expect(text).toContain("(request_id: req_1)");
  });

  it("omits the attempts phrase for a single-attempt (or unknown) failure", () => {
    expect(renderTransportError("fetch failed", null, 1)).not.toContain("attempts");
    expect(renderTransportError("fetch failed", null)).not.toContain("attempts");
  });

  it("shows attempts without an elapsed clause when elapsed is absent", () => {
    expect(renderTransportError("x", null, 3)).toContain("after 3 attempts.");
    expect(renderTransportError("x", null, 3)).not.toContain("over");
  });
});
