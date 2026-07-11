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
    expect(text).toContain("cannot confidently estimate");
    expect(text).toContain("wasn't billed");
    expect(text).not.toContain("No charge");
    expect(text).not.toContain("Estimated");
    // The void path returns early — no footer, and NO "Estimate id" line (that
    // is only added on the non-void render).
    expect(text).not.toContain("Estimate id");
  });

  it("clamps a malformed confidence into [0,1] rather than printing a raw decimal", () => {
    expect(renderEstimate(estimate({ confidence: 1.5 }))).toContain("Confidence: 1.00 (high)");
    expect(renderEstimate(estimate({ confidence: Number.NaN }))).toContain("(very low)");
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
