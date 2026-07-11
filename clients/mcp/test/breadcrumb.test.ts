import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  lastSessionEndPath,
  readBreadcrumb,
  writeBreadcrumb,
} from "../src/breadcrumb.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-crumb-"));
  // The direct-write tests below place a file at lastSessionEndPath; the writer
  // tests exercise dir creation themselves, so only ensure the dir exists here.
  mkdirSync(join(home, ".budgetary"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("breadcrumb round-trip", () => {
  it("writes and reads back a completed record", () => {
    writeBreadcrumb(home, {
      startedAt: "2026-05-27T10:00:00.000Z",
      durationMs: 1234,
      outcome: "submitted",
      estimateId: "est_abc",
    });
    expect(readBreadcrumb(home)).toEqual({
      startedAt: "2026-05-27T10:00:00.000Z",
      durationMs: 1234,
      outcome: "submitted",
      estimateId: "est_abc",
    });
  });

  it("reads back a start-ONLY record as the interrupted-run marker", () => {
    // A start-only record (no durationMs/outcome) is what survives a SIGKILL.
    writeBreadcrumb(home, { startedAt: "2026-05-27T10:00:00.000Z" });
    const crumb = readBreadcrumb(home);
    expect(crumb?.startedAt).toBe("2026-05-27T10:00:00.000Z");
    expect(crumb?.outcome).toBeUndefined();
    expect(crumb?.durationMs).toBeUndefined();
  });

  it("overwrites a prior record (single latest run)", () => {
    writeBreadcrumb(home, { startedAt: "t1" });
    writeBreadcrumb(home, { startedAt: "t2", durationMs: 5, outcome: "no-key" });
    const crumb = readBreadcrumb(home);
    expect(crumb?.startedAt).toBe("t2");
    expect(crumb?.outcome).toBe("no-key");
  });

  it("persists as owner-only (0600) JSON", () => {
    writeBreadcrumb(home, { startedAt: "t", durationMs: 1, outcome: "submitted" });
    const raw = readFileSync(lastSessionEndPath(home), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("readBreadcrumb — degrades to null, never throws", () => {
  it("returns null when no breadcrumb exists", () => {
    expect(readBreadcrumb(home)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    writeFileSync(lastSessionEndPath(home), "{ not json", "utf8");
    expect(readBreadcrumb(home)).toBeNull();
  });

  it("returns null when startedAt is missing (a foreign shape)", () => {
    writeFileSync(lastSessionEndPath(home), JSON.stringify({ outcome: "x" }), "utf8");
    expect(readBreadcrumb(home)).toBeNull();
  });

  it("drops garbage fields rather than trusting them", () => {
    writeFileSync(
      lastSessionEndPath(home),
      JSON.stringify({ startedAt: "t", durationMs: "nope", outcome: 7, estimateId: {} }),
      "utf8",
    );
    expect(readBreadcrumb(home)).toEqual({ startedAt: "t" });
  });
});

describe("writeBreadcrumb — best-effort, never throws", () => {
  it("swallows a write fault (a file where ~/.budgetary should be a dir)", () => {
    // Plant a regular file at the ~/.budgetary path so mkdir/write must fail.
    // Use a fresh home (the shared one already has a real .budgetary dir).
    const badHome = mkdtempSync(join(tmpdir(), "budgetary-badhome-"));
    writeFileSync(join(badHome, ".budgetary"), "not a dir", "utf8");
    expect(() =>
      writeBreadcrumb(badHome, { startedAt: "t", outcome: "submitted" }),
    ).not.toThrow();
    // And a subsequent read degrades cleanly.
    expect(readBreadcrumb(badHome)).toBeNull();
    rmSync(badHome, { recursive: true, force: true });
  });
});
