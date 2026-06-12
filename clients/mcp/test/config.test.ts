import { describe, expect, it } from "vitest";

import { traceTargetEnabled } from "../src/config.js";

const env = (v?: string): NodeJS.ProcessEnv =>
  (v === undefined ? {} : { BUDGETARY_TRACE_TARGET: v }) as NodeJS.ProcessEnv;

describe("traceTargetEnabled — privacy opt-out (fail-safe ON)", () => {
  it("defaults to ON when unset", () => {
    expect(traceTargetEnabled(env())).toBe(true);
  });

  it("treats only explicit off-values as opt-out", () => {
    for (const v of ["0", "false", "off", "no", "OFF", " False ", "No"]) {
      expect(traceTargetEnabled(env(v))).toBe(false);
    }
  });

  it("leaves any other value ON (fail-safe — never silently suppresses)", () => {
    for (const v of ["1", "true", "on", "yes", "", "redacted", "garbage"]) {
      expect(traceTargetEnabled(env(v))).toBe(true);
    }
  });
});
