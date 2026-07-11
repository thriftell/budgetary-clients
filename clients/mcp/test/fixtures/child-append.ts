// Bundled (via esbuild) and spawned as a REAL OS process by store.test.ts's
// concurrency regression test, so N appends genuinely race across processes —
// the store's fail-open advisory lock is what keeps them from
// last-writer-win-clobbering each other's entry (a lost calibration pair).
//
// argv: <storePath> <estimateId> <createdAtIso>
// exit: 0 if the entry was stored, 1 if the append was refused/failed.
import { PendingStore } from "../../src/store.js";

const [storePath, estimateId, createdAt] = process.argv.slice(2);
if (!storePath || !estimateId || !createdAt) {
  process.stderr.write("child-append: missing argv\n");
  process.exit(2);
}

const store = new PendingStore({ path: storePath });
const result = store.append({
  estimate_id: estimateId,
  query: "concurrent-append",
  project_id: "proj_race",
  created_at: createdAt,
  attempts: 0,
});
process.exit(result.stored ? 0 : 1);
