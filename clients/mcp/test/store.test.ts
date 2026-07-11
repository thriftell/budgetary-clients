import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  MAX_ENTRIES,
  MAX_QUERY_LEN,
  PendingStore,
  type PendingEntry,
} from "../src/store.js";

const execFile = promisify(execFileCb);

let dir: string;
let path: string;

// A recent, run-stable timestamp: append() now sweeps entries past the 24h TTL,
// so a fixed calendar date (which drifts past the window over time) would be
// dropped on the next append. Computed once at load → deterministic within a run
// (byte-comparison tests recompute entry() and must match) and always fresh.
const RECENT_TS = new Date().toISOString();

function entry(estimateId: string): PendingEntry {
  return {
    estimate_id: estimateId,
    query: "test",
    project_id: "proj_x",
    created_at: RECENT_TS,
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
        expect(store.append(entry("est_new")).stored).toBe(false);
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

  // A store whose parent dir cannot be created (read-only HOME → EROFS, or a
  // 000 ancestor → EACCES) must degrade to stored:false, NEVER throw — the lock's
  // eager ensureDir() must not escape append()'s no-throw contract. chmod 000 an
  // ancestor to provoke EACCES on the nested mkdir.
  it.skipIf(isRoot)(
    "degrades to stored:false (never throws) when the store dir can't be created",
    () => {
      const locked = join(dir, "locked");
      const nested = join(locked, "sub", "pending.json");
      const store = new PendingStore({ path: nested });
      // Create `locked`, then strip all permissions so the nested mkdir of
      // `locked/sub` fails with EACCES — the eager ensureDir() must swallow it
      // and the append must return stored:false rather than throw.
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      try {
        let result!: ReturnType<PendingStore["append"]>;
        expect(() => {
          result = store.append(entry("est_noroom"));
        }).not.toThrow();
        expect(result.stored).toBe(false);
        expect(result.entries).toEqual([]);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it("append returns the post-append snapshot (no second read needed for a nudge)", () => {
    const store = new PendingStore({ path });
    const r1 = store.append(entry("est_a"));
    expect(r1.stored).toBe(true);
    expect(r1.entries.map((e) => e.estimate_id)).toEqual(["est_a"]);
    const r2 = store.append(entry("est_b"));
    expect(r2.entries.map((e) => e.estimate_id)).toEqual(["est_a", "est_b"]);
  });
});

// ---------------------------------------------------------------------------
// Bounding: append maintenance keeps a hook-less host's store lean and capped.
// ---------------------------------------------------------------------------
describe("PendingStore — bounding (append maintenance)", () => {
  it("truncates the stored query at append (never sent to the server anyway)", () => {
    const store = new PendingStore({ path });
    const long = "x".repeat(MAX_QUERY_LEN + 500);
    const { entries } = store.append({ ...entry("est_long"), query: long });
    expect(entries[0]!.query.length).toBe(MAX_QUERY_LEN);
    // Persisted on disk too — not only in the returned snapshot.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
      entries: PendingEntry[];
    };
    expect(onDisk.entries[0]!.query.length).toBe(MAX_QUERY_LEN);
  });

  it("does not touch a query already within the cap", () => {
    const store = new PendingStore({ path });
    const { entries } = store.append({ ...entry("est_short"), query: "short" });
    expect(entries[0]!.query).toBe("short");
  });

  it("sweeps entries past the 24h TTL on append (bounds a hook-less host)", () => {
    // Seed one long-expired and one fresh entry, then append a third. The append
    // uses a fixed 'now' so the sweep is deterministic and clock-consistent.
    const now = new Date("2026-05-27T12:00:00Z");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { ...entry("est_expired"), created_at: "2026-05-01T00:00:00Z" }, // ~26d old
          { ...entry("est_fresh"), created_at: "2026-05-27T11:00:00Z" }, // 1h old
        ],
      }),
      "utf8",
    );
    const store = new PendingStore({ path });
    const { entries } = store.append(
      { ...entry("est_new"), created_at: now.toISOString() },
      { now: () => now },
    );
    // The expired one is gone; the fresh one and the new one remain.
    expect(entries.map((e) => e.estimate_id)).toEqual(["est_fresh", "est_new"]);
  });

  it("keeps an unparseable/future created_at on the append sweep (never silently lost)", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { ...entry("est_bad_ts"), created_at: "not-a-date" },
          { ...entry("est_future"), created_at: "2027-01-01T00:00:00Z" },
        ],
      }),
      "utf8",
    );
    const store = new PendingStore({ path });
    const { entries } = store.append(
      { ...entry("est_new"), created_at: now.toISOString() },
      { now: () => now },
    );
    expect(entries.map((e) => e.estimate_id).sort()).toEqual(
      ["est_bad_ts", "est_future", "est_new"].sort(),
    );
  });

  it("evicts the oldest past MAX_ENTRIES so the store stays bounded", () => {
    // Pre-seed MAX_ENTRIES fresh entries, then append one more.
    const now = new Date("2026-05-27T12:00:00Z");
    const seeded: PendingEntry[] = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
      ...entry(`est_${String(i).padStart(4, "0")}`),
      created_at: now.toISOString(),
    }));
    writeFileSync(path, JSON.stringify({ version: 1, entries: seeded }), "utf8");
    const warnings: string[] = [];
    const store = new PendingStore({ path, logger: { warn: (m) => warnings.push(m) } });
    const { entries } = store.append(
      { ...entry("est_newest"), created_at: now.toISOString() },
      { now: () => now },
    );
    expect(entries.length).toBe(MAX_ENTRIES);
    // The oldest (est_0000) was evicted; the newest is present.
    expect(entries.some((e) => e.estimate_id === "est_0000")).toBe(false);
    expect(entries[entries.length - 1]!.estimate_id).toBe("est_newest");
    expect(warnings.some((w) => w.includes("evicted"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The headline: N concurrent appends across REAL OS processes must not lose an
// entry. Each append is an unlocked read-modify-write on a shared file, so
// without the advisory lock two writers off one snapshot last-writer-win. This
// proves survivors == N (zero silently lost calibration pairs).
// ---------------------------------------------------------------------------
describe("PendingStore — cross-process concurrency (no lost appends)", () => {
  // Bundle the child entrypoint (store + lock) once into a standalone .mjs so
  // plain `node` can run it — esbuild resolves the .js→.ts specifiers natively.
  let bundlePath: string;
  let bundleDir: string;

  function findEsbuild(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");
    const candidates = [
      join(repoRoot, "node_modules", ".pnpm", "node_modules", ".bin", "esbuild"),
      join(here, "..", "node_modules", ".bin", "esbuild"),
      join(repoRoot, "node_modules", ".bin", "esbuild"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    // Fallback: glob the pnpm virtual store for any esbuild@* bin.
    const pnpm = join(repoRoot, "node_modules", ".pnpm");
    if (existsSync(pnpm)) {
      for (const name of readdirSync(pnpm)) {
        if (name.startsWith("esbuild@")) {
          const bin = join(pnpm, name, "node_modules", "esbuild", "bin", "esbuild");
          if (existsSync(bin)) return bin;
        }
      }
    }
    throw new Error("could not locate an esbuild binary to bundle the child fixture");
  }

  beforeAll(() => {
    bundleDir = mkdtempSync(join(tmpdir(), "budgetary-childbundle-"));
    bundlePath = join(bundleDir, "child-append.mjs");
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "child-append.ts",
    );
    execFileSync(findEsbuild(), [
      fixture,
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${bundlePath}`,
    ]);
  });

  afterAll(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it(
    "loses zero entries across 40 concurrent appending processes",
    async () => {
      const N = 40;
      const createdAt = new Date().toISOString();
      // Fire all spawns first, then await — so they genuinely contend on the RMW.
      const runs = Array.from({ length: N }, (_, i) =>
        execFile("node", [bundlePath, path, `est_${String(i).padStart(3, "0")}`, createdAt]),
      );
      const results = await Promise.allSettled(runs);
      // Every child must report a successful store (exit 0).
      const failed = results.filter((r) => r.status === "rejected");
      expect(failed).toHaveLength(0);

      const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
        entries: PendingEntry[];
      };
      const ids = new Set(onDisk.entries.map((e) => e.estimate_id));
      // Survivors == N: not one racing append was clobbered.
      expect(onDisk.entries.length).toBe(N);
      expect(ids.size).toBe(N);
    },
    30_000,
  );
});
