import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Structural-hallucination measurement (0023e) — two content-free integers
//
// The client measures, over the Python files a run actually produced, how many
// distinct EXTERNAL top-level imports it references and how many of those a
// static resolver finds to be CONFIDENTLY ABSENT — so the server can report how
// often, for tasks like this one, code runs but references a symbol that does
// not exist. It classifies NOTHING and forwards NOTHING but the two counts: no
// symbol name, import statement, file path, or line of code ever leaves the
// machine. Stronger privacy than the trace's redacted `target` — a symbol
// resolver *could* leak names, so this one deliberately never emits them.
//
// The resolution is STATIC. It reads the produced files locally, AST-parses them
// (never executes them), and checks each distinct top-level module name with
// `importlib.util.find_spec`, which resolves a top-level name via the path
// finders WITHOUT importing (and therefore without executing) the module body.
// No arbitrary third-party import is ever run.
//
// It is CONSERVATIVE — under-count, never over-count. A symbol is counted
// `unresolved` only when `find_spec` confidently returns `None`; every ambiguity
// (unreadable/unparseable file, relative or local import, conditional/dynamic
// import, resolver error) is treated as resolved. And the whole measurement is
// FAIL-CLOSED: any doubt about the run (no produced Python, no interpreter,
// resolver crash/timeout, malformed output) omits BOTH counts. The realized
// token total is the contract; these counts are an additive bonus.
//
// Out of scope here (named, not built): deep resolution (submodules, imported
// members `from X import y`, attribute existence `X.foo`) — that needs importing
// modules and so has side effects; v1 is top-level imports only. Semantic
// correctness is never in scope — existence only. Non-Python ecosystems are
// omitted (Python-first).
// ---------------------------------------------------------------------------

/**
 * Two MEASURED integers describing structural existence over a run's produced
 * Python. Nothing else — no name, path, or content — is carried.
 *   - `external` — distinct external, top-level module imports.
 *   - `unresolved` — of those, the ones `find_spec` confidently could not
 *     resolve. Always `0 <= unresolved <= external`.
 */
export interface SymbolCounts {
  external: number;
  unresolved: number;
}

/**
 * Injected subprocess result — the minimal surface {@link resolveHallucinations}
 * reads from a `spawnSync`-style call. `status` is the exit code (`null` when the
 * process never ran, e.g. no interpreter), `stdout` the captured output, `error`
 * any spawn error. Tests substitute this to exercise the orchestration without a
 * real interpreter; production uses {@link defaultPythonRun}.
 */
export interface PythonRunResult {
  status: number | null;
  stdout: string;
  error?: unknown;
}

export type PythonRun = (
  python: string,
  args: string[],
  stdin: string,
) => PythonRunResult;

export interface ResolveOptions {
  /** Interpreter candidates, tried in order until one runs. Default `["python3", "python"]`. */
  pythons?: string[];
  /**
   * Injected runner (tests). Defaults to {@link defaultPythonRun} (`spawnSync`),
   * which owns the hard {@link DEFAULT_TIMEOUT_MS} subprocess wall-clock timeout.
   */
  run?: PythonRun;
}

const DEFAULT_PYTHONS = ["python3", "python"];
const DEFAULT_TIMEOUT_MS = 4000;
/** Cap the resolver's captured stdout so a pathological interpreter can't feed us MBs. */
const MAX_STDOUT_BYTES = 64 * 1024;

/**
 * The bundled static resolver, embedded as source (not a shipped `.py`, so the
 * tsc build needs no asset-copy step and there is no runtime path to resolve).
 * Passed to the interpreter with `-c`; the newline-delimited list of produced
 * file paths arrives on stdin. It emits a single JSON object
 * `{"external": K, "unresolved": J}` on stdout and NOTHING ELSE — never a name,
 * path, or line of code — or emits nothing at all on any internal failure, which
 * the caller reads as "omit both".
 *
 * Everything the resolver does is static and read-only:
 *   • `ast.parse` — parses, never executes.
 *   • `find_spec(top_level_name)` — a dotless top-level name has no parent to
 *     import, so this walks the path finders WITHOUT importing/executing the
 *     target module. No arbitrary third-party code runs.
 * Conservatism is enforced at every branch: skip unreadable/unparseable files;
 * consider only UNCONDITIONAL, module-level imports (a guarded `try/except
 * ImportError` or a function-local import is never counted); exclude relative
 * imports and the project's OWN top-level packages/modules from `external`; and
 * on any `find_spec` error treat the name as resolved. Each artifact's directory
 * AND its package/import root (walked up through `__init__.py`) are added to
 * `sys.path`, so a project-local package still resolves regardless of the
 * process cwd (src-layout and nested packages included) rather than being
 * miscounted as absent.
 */
const RESOLVER_SOURCE = `
import ast, json, os, sys
import importlib.util as ilu

def top_level(name):
    if not name:
        return None
    head = name.split(".")[0].strip()
    return head or None

def main():
    paths = [ln.strip() for ln in sys.stdin.read().splitlines() if ln.strip()]
    if not paths:
        return

    # Import roots to put on sys.path so a PROJECT-LOCAL package still resolves
    # (never over-count it as absent), and the top-level names the produced code
    # OWNS, so an absolute self/cross-package import is excluded from external
    # entirely. Both err toward LOCAL — under-count external, never over-count
    # unresolved.
    dirs = []
    local_modules = set()

    def add_dir(d):
        if d and d not in dirs:
            dirs.append(d)

    def package_root(file_dir):
        # Walk up while the directory is a regular package (has __init__.py). The
        # first ancestor that is NOT a package is the import root; the last
        # package dir's basename is the project's top-level package name.
        d = file_dir
        top = None
        while os.path.isfile(os.path.join(d, "__init__.py")):
            top = os.path.basename(d)
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent
        return d, top

    for p in paths:
        fd = os.path.dirname(os.path.abspath(p))
        add_dir(fd)
        # Parent covers a one-level / namespace self-package import (a file in
        # dir "pkg" doing "import pkg") even without an __init__.py marker.
        add_dir(os.path.dirname(fd))
        root, top = package_root(fd)
        add_dir(root)  # src-layout / nested packages: the true import root.
        if top:
            local_modules.add(top)
        base = os.path.basename(p)
        if base.endswith(".py"):
            stem = base[:-3]
            if stem:
                local_modules.add(stem)

    def is_local(name, file_dir):
        if name in local_modules:
            return True
        if os.path.isfile(os.path.join(file_dir, name + ".py")):
            return True
        if os.path.isfile(os.path.join(file_dir, name, "__init__.py")):
            return True
        if os.path.isdir(os.path.join(file_dir, name)):
            return True
        return False

    external = set()
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8") as f:
                src = f.read()
        except Exception:
            continue
        try:
            tree = ast.parse(src)
        except Exception:
            continue
        file_dir = os.path.dirname(os.path.abspath(p))
        # Only unconditional, module-level imports (direct children of the module
        # body). A conditional/dynamic import (inside try/except, if, with, a
        # function, etc.) is deliberately never considered.
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    head = top_level(alias.name)
                    if head and not is_local(head, file_dir):
                        external.add(head)
            elif isinstance(node, ast.ImportFrom):
                if node.level and node.level > 0:
                    continue
                head = top_level(node.module or "")
                if head and not is_local(head, file_dir):
                    external.add(head)

    # Resolve WITHOUT executing. The artifact dirs and their package/import roots
    # go on sys.path first so a project-local package still resolves regardless of
    # the process cwd (never over-count it as absent).
    for d in dirs:
        if d not in sys.path:
            sys.path.insert(0, d)

    unresolved = 0
    for name in external:
        try:
            spec = ilu.find_spec(name)
        except Exception:
            continue
        if spec is None:
            unresolved += 1

    sys.stdout.write(json.dumps({"external": len(external), "unresolved": unresolved}))

try:
    main()
except Exception:
    pass
`;

/** Production runner: `spawnSync` with the interpreter, capturing stdout only. */
export const defaultPythonRun: PythonRun = (python, args, stdin) => {
  try {
    const res = spawnSync(python, args, {
      input: stdin,
      encoding: "utf8",
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_STDOUT_BYTES,
      // No shell — args are passed as an array, so nothing is interpreted.
      windowsHide: true,
    });
    return {
      status: res.status,
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      error: res.error,
    };
  } catch (err) {
    return { status: null, stdout: "", error: err };
  }
};

/**
 * Parse the resolver's stdout into validated {@link SymbolCounts}, or `null` when
 * it is malformed (the fail-closed contract). Requires a single JSON object with
 * non-negative integer `external`/`unresolved` and `unresolved <= external` — any
 * deviation omits both.
 */
function parseCounts(stdout: string): SymbolCounts | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const external = obj.external;
  const unresolved = obj.unresolved;
  if (
    typeof external !== "number" ||
    typeof unresolved !== "number" ||
    !Number.isInteger(external) ||
    !Number.isInteger(unresolved) ||
    external < 0 ||
    unresolved < 0 ||
    unresolved > external
  ) {
    return null;
  }
  return { external, unresolved };
}

/**
 * Measure structural-existence counts over a run's produced Python artifacts,
 * or `null` to omit both (fail-closed). Steps:
 *   1. Keep only artifacts STILL PRESENT on disk at session close (deleted files
 *      are no longer part of the produced surface). No survivors ⇒ `null`.
 *   2. Run the bundled static resolver ({@link RESOLVER_SOURCE}) under the first
 *      interpreter that executes, with the surviving paths on stdin.
 *   3. Return the validated counts, or `null` on no-interpreter / non-zero exit /
 *      spawn error / malformed output.
 *
 * The input `artifacts` are RAW local paths used only to read the files here;
 * they never leave the machine. Only the two integers are returned, and only the
 * two integers are ever forwarded.
 */
export function resolveHallucinations(
  artifacts: readonly string[],
  options: ResolveOptions = {},
): SymbolCounts | null {
  // Python-first, and only files that survived to session close.
  const present = artifacts.filter(
    (p) => typeof p === "string" && p.endsWith(".py") && existsSync(p),
  );
  if (present.length === 0) return null;

  const run = options.run ?? defaultPythonRun;
  const pythons = options.pythons ?? DEFAULT_PYTHONS;
  const stdin = present.join("\n");

  for (const python of pythons) {
    let result: PythonRunResult;
    try {
      result = run(python, ["-c", RESOLVER_SOURCE], stdin);
    } catch {
      // A throwing runner is treated like a failed interpreter — try the next.
      continue;
    }
    // Interpreter not found / failed to launch → try the next candidate.
    if (result.error !== undefined || result.status === null) continue;
    // Ran but exited non-zero → conservative omit (do not fall through to a
    // second interpreter that might disagree).
    if (result.status !== 0) return null;
    return parseCounts(result.stdout);
  }
  return null;
}
