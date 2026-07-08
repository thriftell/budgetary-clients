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
  dir = mkdtempSync(join(tmpdir(), "budgetary-store-"));
  path = join(dir, "pending.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PendingStore", () => {
  it("returns empty store when file is absent", () => {
    const store = new PendingStore({ path });
    expect(store.read()).toEqual({ version: 1, entries: [] });
  });

  it("appends entries and persists them (newest last)", () => {
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
    const file = store.read();
    expect(file.entries).toEqual([]);
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

    // After write, the temp file is gone and the real file exists.
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.entries[0].estimate_id).toBe("est_atomic");
  });

  it("serializes with the version:1 schema and 2-space indent (Claude Code compatible)", () => {
    const store = new PendingStore({ path });
    store.write({ version: 1, entries: [entry("est_fmt")] });
    const raw = readFileSync(path, "utf8");
    // Byte-for-byte compatible with the first-party clients' writer.
    expect(raw).toBe(
      JSON.stringify({ version: 1, entries: [entry("est_fmt")] }, null, 2),
    );
  });

  it("creates the parent directory when missing", () => {
    const nested = join(dir, "nested", "more", "pending.json");
    const store = new PendingStore({ path: nested });
    store.append(entry("est_nested"));
    expect(existsSync(nested)).toBe(true);
  });

  it("keeps valid entries and drops only the malformed ones", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          entry("est_ok"),
          { estimate_id: "bad", query: "q" }, // missing project_id/created_at/attempts
          entry("est_ok2"),
        ],
      }),
      "utf8",
    );
    const warnings: string[] = [];
    const store = new PendingStore({
      path,
      logger: { warn: (m) => warnings.push(m) },
    });
    // The whole file is not discarded for one bad entry.
    expect(store.read().entries.map((e) => e.estimate_id)).toEqual([
      "est_ok",
      "est_ok2",
    ]);
    expect(warnings).toHaveLength(1);
  });

  it("refuses to append over an unreadable store, preserving the bytes", () => {
    writeFileSync(path, "{corrupt json", "utf8");
    const warnings: string[] = [];
    const store = new PendingStore({
      path,
      logger: { warn: (m) => warnings.push(m) },
    });
    store.append(entry("est_new"));
    // The corrupt bytes are intact; the append did not clobber them with a
    // store that would have silently dropped whatever was there.
    expect(readFileSync(path, "utf8")).toBe("{corrupt json");
    expect(warnings.some((w) => w.includes("not appending"))).toBe(true);
  });

  it("refuses to append an entry without an estimate_id", () => {
    const warnings: string[] = [];
    const store = new PendingStore({
      path,
      logger: { warn: (m) => warnings.push(m) },
    });
    store.append({ ...entry("x"), estimate_id: "" });
    expect(existsSync(path)).toBe(false); // nothing written
    expect(warnings.some((w) => w.includes("estimate_id"))).toBe(true);
  });
});
