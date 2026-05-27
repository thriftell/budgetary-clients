import { describe, expect, it } from "vitest";
import { BudgetaryClient } from "../src/index";

describe("BudgetaryClient", () => {
  it("constructs without throwing", () => {
    const client = new BudgetaryClient({ apiKey: "test-key" });
    expect(client).toBeInstanceOf(BudgetaryClient);
  });
});
