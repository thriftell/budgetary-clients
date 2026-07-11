import { describe, expect, it } from "vitest";
import type { EstimateResponse } from "@budgetary/sdk";

import {
  renderAuthFailed,
  renderEstimate,
  renderPermissionDenied,
  renderRateLimited,
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

    expect(renderRateLimited(5, "req_c")).toContain("(request_id: req_c)");
    expect(renderRateLimited(5)).not.toContain("request_id");
    expect(renderRateLimited(null, "req_d")).toContain("(request_id: req_d)");
  });
});
