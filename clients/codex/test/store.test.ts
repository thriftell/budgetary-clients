// Ported verbatim from clients/claude-code/test/store.test.ts (only import
// paths differ). The store schema is shared between plugins; behaviors must
// stay identical.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PendingStore, type PendingEntry } from "../src/store.js";

let dir: string;
let path: string;

function entry(estimateId: string): PendingEntry {
  return {
    estimate_id: estimateId,
    query: "test",
    project_id: "proj_x",
    created_at: "2026-05-27T10:14:00Z",
    attempts: 0,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budgetary-codex-store-"));
  path = join(dir, "pending.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PendingStore (Codex)", () => {
  it("returns empty store when file is absent", () => {
    const store = new PendingStore({ path });
    expect(store.read()).toEqual({ version: 1, entries: [] });
  });

  it("appends entries and persists them", () => {
    const store = new PendingStore({ path });
    store.append(entry("est_1"));
    store.append(entry("est_2"));

    const fresh = new PendingStore({ path });
    const file = fresh.read();
    expect(file.entries.map((e) => e.estimate_id)).toEqual(["est_1", "est_2"]);
  });

  it("recovers from corrupt JSON without crashing", () => {
    writeFileSync(path, "{not valid json", "utf8");
    const warnings: string[] = [];
    const store = new PendingStore({
      path,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(store.read().entries).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("recovers from a structurally invalid store", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 99, entries: "not an array" }),
      "utf8",
    );
    const warnings: string[] = [];
    const store = new PendingStore({
      path,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(store.read().entries).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("writes atomically via a temp file and rename", () => {
    const store = new PendingStore({ path });
    store.write({ version: 1, entries: [entry("est_atomic")] });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.entries[0].estimate_id).toBe("est_atomic");
  });

  it("creates the parent directory when missing", () => {
    const nested = join(dir, "nested", "more", "pending.json");
    const store = new PendingStore({ path: nested });
    store.append(entry("est_nested"));
    expect(existsSync(nested)).toBe(true);
  });
});
