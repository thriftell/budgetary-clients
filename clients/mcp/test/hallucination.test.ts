import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultPythonRun,
  resolveHallucinations,
  type PythonRun,
  type PythonRunResult,
} from "../src/hallucination.js";

// A working interpreter for the end-to-end resolver tests (skipped where none).
const PYTHON = ["python3", "python"].find((p) => {
  const r = spawnSync(p, ["-c", "0"], { encoding: "utf8" });
  return !r.error && r.status === 0;
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budgetary-halluc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function py(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source, "utf8");
  return path;
}

// A runner that returns a scripted result and records how it was called.
function scriptedRun(result: PythonRunResult | (() => PythonRunResult)) {
  const calls: Array<{ python: string; stdin: string }> = [];
  const run: PythonRun = (python, _args, stdin) => {
    calls.push({ python, stdin });
    return typeof result === "function" ? result() : result;
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// Orchestration — injected runner, no interpreter required. Proves the
// fail-closed contract and that only surviving .py artifacts are measured.
// ---------------------------------------------------------------------------

describe("resolveHallucinations — orchestration (injected runner)", () => {
  const ok = (external: number, unresolved: number): PythonRunResult => ({
    status: 0,
    stdout: JSON.stringify({ external, unresolved }),
  });

  it("omits (null) with no produced Python and never spawns the interpreter", () => {
    const { run, calls } = scriptedRun(ok(3, 1));
    expect(resolveHallucinations([], { run })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("omits when no artifact survives to session close (existsSync filter)", () => {
    const { run, calls } = scriptedRun(ok(3, 1));
    // A .py path that was never created → filtered out → nothing to resolve.
    expect(resolveHallucinations([join(dir, "gone.py")], { run })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("filters non-Python artifacts before resolving (Python-first)", () => {
    const ts = py("a.ts", "const x = 1;\n");
    const { run, calls } = scriptedRun(ok(3, 1));
    expect(resolveHallucinations([ts], { run })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns validated counts and hands the surviving paths to the runner", () => {
    const a = py("a.py", "import os\n");
    const b = py("b.py", "import sys\n");
    const { run, calls } = scriptedRun(ok(2, 1));
    expect(resolveHallucinations([a, b], { run })).toEqual({
      external: 2,
      unresolved: 1,
    });
    // The runner receives the raw paths on stdin (used locally only).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stdin.split("\n").sort()).toEqual([a, b].sort());
  });

  it("accepts a valid zero result (local-only run is an honest 0/0)", () => {
    const a = py("a.py", "from . import helper\n");
    const { run } = scriptedRun(ok(0, 0));
    expect(resolveHallucinations([a], { run })).toEqual({ external: 0, unresolved: 0 });
  });

  it("tries the next interpreter when the first cannot launch", () => {
    const a = py("a.py", "import os\n");
    const results: PythonRunResult[] = [
      { status: null, stdout: "", error: new Error("ENOENT") },
      { status: 0, stdout: JSON.stringify({ external: 1, unresolved: 0 }) },
    ];
    let i = 0;
    const calls: string[] = [];
    const run: PythonRun = (python) => {
      calls.push(python);
      return results[i++]!;
    };
    expect(
      resolveHallucinations([a], { pythons: ["py-a", "py-b"], run }),
    ).toEqual({ external: 1, unresolved: 0 });
    expect(calls).toEqual(["py-a", "py-b"]);
  });

  it("omits on a non-zero exit (does not fall through to another interpreter)", () => {
    const a = py("a.py", "import os\n");
    const calls: string[] = [];
    const run: PythonRun = (python) => {
      calls.push(python);
      return { status: 1, stdout: "" };
    };
    expect(resolveHallucinations([a], { pythons: ["py-a", "py-b"], run })).toBeNull();
    expect(calls).toEqual(["py-a"]);
  });

  it("omits when every interpreter is missing", () => {
    const a = py("a.py", "import os\n");
    const { run } = scriptedRun({ status: null, stdout: "", error: new Error("x") });
    expect(resolveHallucinations([a], { pythons: ["py-a"], run })).toBeNull();
  });

  it("omits on a throwing runner", () => {
    const a = py("a.py", "import os\n");
    const run: PythonRun = () => {
      throw new Error("boom");
    };
    expect(resolveHallucinations([a], { pythons: ["py-a"], run })).toBeNull();
  });

  it("omits on malformed / non-JSON output", () => {
    const a = py("a.py", "import os\n");
    for (const stdout of ["", "   ", "not json", "[1,2]", "null", "{}"]) {
      const { run } = scriptedRun({ status: 0, stdout });
      expect(resolveHallucinations([a], { run })).toBeNull();
    }
  });

  it("omits on out-of-contract counts (unresolved>external, negative, non-integer)", () => {
    const a = py("a.py", "import os\n");
    const bad = [
      { external: 1, unresolved: 2 },
      { external: -1, unresolved: 0 },
      { external: 1, unresolved: -1 },
      { external: 1.5, unresolved: 0 },
      { external: 2, unresolved: 1.2 },
    ];
    for (const b of bad) {
      const { run } = scriptedRun({ status: 0, stdout: JSON.stringify(b) });
      expect(resolveHallucinations([a], { run })).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Static resolver — real interpreter. This is the crux: the two counts must be
// MEASURED, CONSERVATIVE, and STATIC (no produced file is ever executed).
// ---------------------------------------------------------------------------

const realDescribe = PYTHON ? describe : describe.skip;

realDescribe("resolveHallucinations — static resolver (real interpreter)", () => {
  const opts = { pythons: [PYTHON!] };

  it("counts K distinct external imports of which J do not resolve", () => {
    const f = py(
      "prog.py",
      [
        "import os",
        "import sys",
        "import json",
        "import definitely_not_a_real_pkg_zzz",
        "import another_missing_pkg_qqq as q",
      ].join("\n"),
    );
    expect(resolveHallucinations([f], opts)).toEqual({ external: 5, unresolved: 2 });
  });

  it("flags a fabricated package (unresolved >= 1)", () => {
    const f = py("fab.py", "import totally_made_up_package_9x8y7z\n");
    const counts = resolveHallucinations([f], opts)!;
    expect(counts.unresolved).toBeGreaterThanOrEqual(1);
    expect(counts.unresolved).toBeLessThanOrEqual(counts.external);
  });

  it("reports external=0 for a local/relative-import-only file", () => {
    py("sibling.py", "VALUE = 1\n");
    const f = py(
      "main.py",
      ["from . import somewhere", "from .pkg import thing", "import sibling"].join("\n"),
    );
    expect(resolveHallucinations([f], opts)).toEqual({ external: 0, unresolved: 0 });
  });

  it("does NOT over-count a project-local package imported by absolute name (src-layout)", () => {
    // A produced file that lives INSIDE a package and imports that package by
    // its absolute top-level name. The package exists on disk, so it must never
    // be counted unresolved — even though the process cwd is not the import root.
    // (Regression for the src-layout / nested-package over-count.)
    const pkgDir = join(dir, "src", "mypkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "__init__.py"), "", "utf8");
    writeFileSync(join(pkgDir, "other.py"), "", "utf8");
    writeFileSync(join(pkgDir, "utils.py"), "HELPER = 1\n", "utf8");
    const mod = join(pkgDir, "mod.py");
    writeFileSync(
      mod,
      [
        "import mypkg.other",
        "from mypkg.utils import HELPER",
        "import os",
        "import genuinely_missing_pkg_xyz",
      ].join("\n"),
      "utf8",
    );
    // `mypkg` is the project's own package → excluded from external; `os`
    // resolves; only the fabricated import is unresolved.
    expect(resolveHallucinations([mod], opts)).toEqual({ external: 2, unresolved: 1 });
  });

  it("resolves a cross-package import within a nested package tree", () => {
    const subDir = join(dir, "pkg", "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(dir, "pkg", "__init__.py"), "", "utf8");
    writeFileSync(join(subDir, "__init__.py"), "", "utf8");
    const deep = join(subDir, "deep.py");
    writeFileSync(
      deep,
      ["import pkg.sub.thing", "from pkg import helper", "import a_real_missing_dep_qq"].join("\n"),
      "utf8",
    );
    // `pkg` is the owned top-level package → local; only the fabricated dep is external.
    expect(resolveHallucinations([deep], opts)).toEqual({ external: 1, unresolved: 1 });
  });

  it("excludes another produced artifact's own module name from external", () => {
    const util = py("util.py", "HELPER = 1\n");
    const app = py("app.py", "import util\nimport os\n");
    // `util` is a produced sibling module → local → excluded; only `os` is external.
    expect(resolveHallucinations([app, util], opts)).toEqual({
      external: 1,
      unresolved: 0,
    });
  });

  it("never counts a conditional (try/except) import as unresolved", () => {
    const f = py(
      "cond.py",
      [
        "try:",
        "    import a_missing_optional_dep_777",
        "except ImportError:",
        "    a_missing_optional_dep_777 = None",
      ].join("\n"),
    );
    // The guarded import is not a module-level unconditional import → not considered.
    expect(resolveHallucinations([f], opts)).toEqual({ external: 0, unresolved: 0 });
  });

  it("never counts a function-local import", () => {
    const f = py(
      "fn.py",
      ["def load():", "    import a_missing_lazy_dep_555", "    return a_missing_lazy_dep_555"].join(
        "\n",
      ),
    );
    expect(resolveHallucinations([f], opts)).toEqual({ external: 0, unresolved: 0 });
  });

  it("skips an unparseable file but still measures its parseable siblings", () => {
    const broken = py("broken.py", "def (:\n  this is not python\n");
    const good = py("good.py", "import os\nimport still_missing_pkg_444\n");
    expect(resolveHallucinations([broken, good], opts)).toEqual({
      external: 2,
      unresolved: 1,
    });
  });

  it("counts a top-level `from X import y` under X (member y not checked)", () => {
    const f = py("frm.py", "from os import path\nfrom missing_top_888 import thing\n");
    expect(resolveHallucinations([f], opts)).toEqual({ external: 2, unresolved: 1 });
  });

  it("never executes a produced file's body (static parse + find_spec only)", () => {
    const marker = join(dir, "SIDE_EFFECT_HAPPENED");
    // If this file's body ever ran, the marker would be created.
    const f = py(
      "evil.py",
      ["import os", `open(${JSON.stringify(marker)}, "w").close()`].join("\n"),
    );
    resolveHallucinations([f], opts);
    expect(existsSync(marker)).toBe(false);
  });

  it("emits ONLY the two integers — no symbol name, path, or code in stdout", () => {
    const f = py("leak.py", "import os\nimport a_secret_sounding_pkg_name_123\n");
    let captured = "";
    const capturing: PythonRun = (python, args, stdin) => {
      const r = defaultPythonRun(python, args, stdin);
      captured = r.stdout;
      return r;
    };
    const counts = resolveHallucinations([f], { pythons: [PYTHON!], run: capturing })!;
    expect(counts).toEqual({ external: 2, unresolved: 1 });
    // The resolver's entire output is a two-integer JSON object — nothing else.
    expect(captured.trim()).toMatch(/^\{\s*"external":\s*\d+,\s*"unresolved":\s*\d+\s*\}$/);
    expect(captured).not.toContain("a_secret_sounding_pkg_name_123");
    expect(captured).not.toContain("leak.py");
    expect(captured).not.toContain(dir);
  });
});
