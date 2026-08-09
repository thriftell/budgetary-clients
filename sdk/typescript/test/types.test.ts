import { describe, expect, it } from "vitest";

import { CENSORING_CATEGORIES, normalizeScenario } from "../src/index.js";
import type { ActualsRequest } from "../src/index.js";

describe("normalizeScenario", () => {
  it("returns the known scenarios unchanged", () => {
    expect(normalizeScenario("confident")).toBe("confident");
    expect(normalizeScenario("uncertain")).toBe("uncertain");
    expect(normalizeScenario("sparse_evidence")).toBe("sparse_evidence");
    expect(normalizeScenario("out_of_domain")).toBe("out_of_domain");
  });

  it("folds any unknown/future label to 'uncertain' (never 'confident')", () => {
    expect(normalizeScenario("brand_new_label")).toBe("uncertain");
    expect(normalizeScenario("")).toBe("uncertain");
    expect(normalizeScenario("CONFIDENT")).toBe("uncertain"); // case-sensitive by design
    // A prototype key must not masquerade as a known scenario.
    expect(normalizeScenario("toString")).toBe("uncertain");
    expect(normalizeScenario("constructor")).toBe("uncertain");
  });
});

describe("CENSORING_CATEGORIES — the closed run-termination vocabulary (contract §4.2)", () => {
  it("is exactly the contract's four members, verbatim", () => {
    expect(CENSORING_CATEGORIES).toEqual([
      "natural",
      "harness_watchdog",
      "operative_cap",
      "kill_switch",
    ]);
  });

  it("ActualsRequest carries the category as an OPTIONAL closed-union field", () => {
    // Compile-time: `censoring` accepts only the four literals (there is
    // deliberately no normalize helper — an unknown category has no safe
    // cautious floor the way an unknown scenario does, and omission is the only
    // honest fallback). Runtime: an omitted field stays omitted; no default
    // sneaks in anywhere.
    const declared: ActualsRequest = {
      estimateId: "e",
      tokensIn: 1,
      tokensOut: 2,
      success: true,
      durationMs: 3,
      censoring: "harness_watchdog",
    };
    const undeclared: ActualsRequest = {
      estimateId: "e",
      tokensIn: 1,
      tokensOut: 2,
      success: true,
      durationMs: 3,
    };
    expect(declared.censoring).toBe("harness_watchdog");
    expect("censoring" in undeclared).toBe(false);
  });
});
