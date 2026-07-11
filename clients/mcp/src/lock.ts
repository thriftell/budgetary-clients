import { statSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * A best-effort, FAIL-OPEN advisory file lock for serializing the pending
 * store's read-modify-write across concurrent `npx @budgetary/mcp` processes.
 *
 * Each *write* is already torn-free (unique temp + rename), but the RMW —
 * read a snapshot, mutate it, write it back — is not serialized: two writers
 * off one snapshot last-writer-win, silently dropping the other's entry. At the
 * realistic 2–10 parallel sessions this measurably loses calibration pairs at
 * fan-out (`estimate` append) and fan-in (session-end submit).
 *
 * The lock is deliberately WEAK: it exists to make the common concurrent case
 * lossless, NOT to be a hard mutex. Its overriding constraint is the 30 s
 * session-end hook budget — a lock must NEVER block long enough to risk a
 * SIGKILL. So after a short bounded wait it FAILS OPEN: it runs the critical
 * section anyway, degrading to today's unlocked (occasionally-lossy) behavior
 * rather than stalling. A held lock, a dead lock-holder, or an unwritable lock
 * directory all resolve to "proceed" within a few hundred milliseconds.
 */

/** Retry the O_EXCL create this many times before giving up and failing open. */
const LOCK_MAX_TRIES = 8;
/** Jittered per-retry backoff bounds (ms). Worst case ≈ 8 × 20 = 160 ms. */
const LOCK_MIN_SLEEP_MS = 5;
const LOCK_MAX_SLEEP_MS = 20;
/**
 * A lock file older than this is assumed abandoned by a crashed/SIGKILLed
 * holder and is broken (unlinked) so it can't wedge the queue forever. Chosen
 * well above the few-ms a real critical section holds the lock, and below the
 * 30 s hook budget.
 */
const LOCK_STALE_MS = 10_000;

/**
 * Block the current thread for `ms` WITHOUT a busy-spin. The store's fs calls
 * are synchronous, so the lock retry must be synchronous too; `Atomics.wait` on
 * a throwaway buffer parks the thread (no CPU burn, no event-loop dependency).
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  // The value never becomes non-zero, so this always waits the full timeout.
  Atomics.wait(shared, 0, 0, Math.max(0, Math.ceil(ms)));
}

export interface FileLockOptions {
  /** Injectable jitter source (tests). */
  random?: () => number;
  /** Injectable synchronous sleep (tests). */
  sleep?: (ms: number) => void;
  /** Injectable wall clock for stale detection (tests); defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run `fn` while holding the advisory lock at `lockPath`, releasing it in a
 * `finally`. Acquisition is best-effort and FAIL-OPEN: on a timeout, a stale
 * break race, or any error that prevents even attempting the lock, `fn` still
 * runs (unlocked). The lock is released only if THIS call acquired it, so a
 * fail-open run never deletes a lock another process legitimately holds.
 *
 * `fn` runs exactly once regardless of whether the lock was acquired — the
 * lock only affects whether concurrent callers are serialized, never whether
 * the work happens.
 */
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? sleepSync;
  const now = opts.now ?? Date.now;

  let acquired = false;
  for (let i = 0; i < LOCK_MAX_TRIES; i++) {
    try {
      // O_EXCL: the create succeeds for exactly one process; every other gets
      // EEXIST. `0600` matches the owner-only convention under ~/.budgetary.
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      acquired = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "EEXIST") {
        // The directory is missing, unwritable, or otherwise can't host a lock.
        // There's nothing to wait for — fail open immediately (the store's own
        // write will create/repair the directory, or fail loudly on its own).
        break;
      }
      // Held by another process. Break it if it looks abandoned.
      try {
        const st = statSync(lockPath);
        if (now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue; // retry the create immediately after breaking a stale lock
        }
      } catch {
        // stat/unlink raced with the holder releasing — just fall through to
        // sleep + retry; the next create will settle it.
      }
      if (i < LOCK_MAX_TRIES - 1) {
        sleep(LOCK_MIN_SLEEP_MS + random() * (LOCK_MAX_SLEEP_MS - LOCK_MIN_SLEEP_MS));
      }
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort release: if we somehow can't unlink our own lock, the
        // 10 s stale-break reclaims it. Never let a release fault escape.
      }
    }
  }
}
