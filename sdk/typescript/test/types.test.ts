import { describe, expect, it } from "vitest";

import { normalizeScenario } from "../src/index.js";

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
