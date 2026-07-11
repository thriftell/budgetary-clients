import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

  it("creates the store dir owner-only (0700) and the file owner-only (0600)", () => {
    // The store lives beside config.json (the API key); it must not be group- or
    // world-accessible.
    const nested = join(dir, "secretdir", "pending.json");
    const store = new PendingStore({ path: nested });
    store.append(entry("est_perms"));
    expect(statSync(join(dir, "secretdir")).mode & 0o077).toBe(0);
    expect(statSync(nested).mode & 0o077).toBe(0);
  });

  it("tightens the file to 0600 even over a pre-existing loose file", () => {
    // Simulate a store left world-readable by an older client, then rewrite it.
    writeFileSync(path, JSON.stringify({ version: 1, entries: [] }), { mode: 0o644 });
    new PendingStore({ path }).append(entry("est_tighten"));
    expect(statSync(path).mode & 0o077).toBe(0);
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

  // A read failure that is NOT ENOENT (a lost read permission, EIO, a directory
  // in the way) must fail closed, not be mistaken for a first run. The old
  // `existsSync` pre-check returned false for ANY error, silently routing an
  // unreadable store down the "empty + writable" path so the next append
  // clobbered the whole queue with a fresh one-entry file. chmod 000 the file to
  // provoke EACCES and prove the queue is preserved instead.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)(
    "fails closed on an unreadable store (errno != ENOENT), preserving the bytes",
    () => {
      writeFileSync(
        path,
        JSON.stringify({ version: 1, entries: [entry("est_keep")] }),
        "utf8",
      );
      chmodSync(path, 0o000);
      try {
        const warnings: string[] = [];
        const store = new PendingStore({
          path,
          logger: { warn: (m) => warnings.push(m) },
        });
        // read() can't see the bytes → empty, and NOT writable ...
        expect(store.read().entries).toEqual([]);
        // ... so append REFUSES rather than overwriting the unreadable queue.
        expect(store.append(entry("est_new"))).toBe(false);
        expect(warnings.some((w) => w.includes("could not read"))).toBe(true);
        expect(warnings.some((w) => w.includes("not appending"))).toBe(true);
      } finally {
        chmodSync(path, 0o600);
      }
      // The original entry survives — the queue was never clobbered.
      expect(
        JSON.parse(readFileSync(path, "utf8")).entries.map(
          (e: PendingEntry) => e.estimate_id,
        ),
      ).toEqual(["est_keep"]);
    },
  );

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
