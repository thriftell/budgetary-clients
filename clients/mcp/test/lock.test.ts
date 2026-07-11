import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFileLock } from "../src/lock.js";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budgetary-lock-"));
  lockPath = join(dir, "pending.json.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("acquires the lock (create-exclusive) and releases it in finally", () => {
    let sawLock = false;
    const ret = withFileLock(lockPath, () => {
      // Inside the critical section the lock file exists.
      sawLock = existsSync(lockPath);
      return "done";
    });
    expect(ret).toBe("done");
    expect(sawLock).toBe(true);
    // Released after the section.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("runs fn exactly once and returns its value even under contention", () => {
    let calls = 0;
    // A held, FRESH lock (recent mtime) — never breakable within the window.
    writeFileSync(lockPath, "999999\n");
    const value = withFileLock(
      lockPath,
      () => {
        calls += 1;
        return 42;
      },
      // No-op sleep so the fail-open retries don't actually block the test.
      { sleep: () => {}, random: () => 0.5, now: () => Date.parse("2020-01-01T00:00:00Z") },
    );
    expect(value).toBe(42);
    expect(calls).toBe(1);
  });

  it("FAILS OPEN on a held fresh lock: runs fn without blocking, leaves the foreign lock intact", () => {
    // Simulate another live process holding the lock right now.
    writeFileSync(lockPath, "12345\n");
    const before = statSync(lockPath).mtimeMs;
    let ran = false;
    let sleeps = 0;
    withFileLock(
      lockPath,
      () => {
        ran = true;
      },
      {
        sleep: () => {
          sleeps += 1;
        },
        random: () => 1,
        // "now" close to the lock's mtime so it's never considered stale.
        now: () => before + 100,
      },
    );
    // It retried (so it genuinely tried to acquire) then failed open and ran.
    expect(sleeps).toBeGreaterThan(0);
    expect(ran).toBe(true);
    // It must NOT delete a lock it did not acquire — the real holder still owns it.
    expect(existsSync(lockPath)).toBe(true);
  });

  it("breaks a STALE lock (holder died) and acquires it", () => {
    writeFileSync(lockPath, "666\n");
    const mtime = statSync(lockPath).mtimeMs;
    let ran = false;
    withFileLock(
      lockPath,
      () => {
        ran = true;
        // We acquired it: our own lock exists during the section.
        expect(existsSync(lockPath)).toBe(true);
      },
      {
        sleep: () => {},
        random: () => 0,
        // 20 s past the lock's mtime → older than the 10 s stale window.
        now: () => mtime + 20_000,
      },
    );
    expect(ran).toBe(true);
    // Acquired ⇒ released on exit.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("still runs fn when the lock directory doesn't exist (fails open immediately)", () => {
    const missing = join(dir, "nope", "pending.json.lock");
    let ran = false;
    let sleeps = 0;
    withFileLock(
      missing,
      () => {
        ran = true;
      },
      { sleep: () => (sleeps += 1) },
    );
    // No directory to host a lock → fail open at once, no retry-sleeping.
    expect(ran).toBe(true);
    expect(sleeps).toBe(0);
  });

  it("releases the lock even when fn throws", () => {
    expect(() =>
      withFileLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });
});
