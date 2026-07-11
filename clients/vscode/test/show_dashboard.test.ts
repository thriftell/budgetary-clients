import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";

import * as vscodeStub from "./vscode-stub";
import { load, showDashboard } from "../src/commands/show_dashboard";
import { BudgetaryAuthError } from "@budgetary/sdk";

// A controllable `getLedger`: every call returns a fresh deferred we resolve by
// hand, so we can drive two loads to overlap deterministically.
const ctl = vi.hoisted(() => {
  const deferreds: Array<{
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  return {
    deferreds,
    next(): Promise<unknown> {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      deferreds.push({ resolve, reject });
      return promise;
    },
    reset() {
      deferreds.length = 0;
    },
  };
});

// Fake only the network client; keep the real config resolver (now sourced from
// @budgetary/sdk) and the real error classes so resolveConfigStatus() works and
// `instanceof` checks in show_dashboard match what the tests construct.
vi.mock("@budgetary/sdk", async () => {
  const actual = await vi.importActual<typeof import("@budgetary/sdk")>(
    "@budgetary/sdk",
  );
  return {
    ...actual,
    BudgetaryClient: class {
      getLedger(): Promise<unknown> {
        return ctl.next();
      }
    },
  };
});

// The fake carries the few members the command touches at runtime, plus test-
// only inspection fields. Typed as an intersection with the real WebviewPanel so
// `load()` (which takes a `vscode.WebviewPanel`) accepts it without a cast at the
// call sites — the single `as unknown as` in makeFakePanel bridges the mock.
interface FakePanelInternals {
  _disposed: boolean;
  _html: string;
  _visible: boolean;
  _onDispose?: () => void;
  _onViewState?: (e: { webviewPanel: vscode.WebviewPanel }) => void;
}
type FakePanel = vscode.WebviewPanel & FakePanelInternals;

function makeFakePanel(): FakePanel {
  const p = {
    _disposed: false,
    _html: "",
    _visible: true,
    get visible() {
      return p._visible;
    },
    webview: {
      get html() {
        return p._html;
      },
      set html(v: string) {
        if (p._disposed) throw new Error("cannot set html on a disposed webview");
        p._html = v;
      },
      onDidReceiveMessage() {
        return { dispose() {} };
      },
    },
    onDidDispose(cb: () => void) {
      p._onDispose = cb;
      return { dispose() {} };
    },
    onDidChangeViewState(cb: (e: { webviewPanel: vscode.WebviewPanel }) => void) {
      p._onViewState = cb;
      return { dispose() {} };
    },
    reveal() {},
    dispose() {},
  } as unknown as FakePanel;
  return p;
}

/** Simulate the panel being hidden then re-shown (fires onDidChangeViewState). */
function fireViewStateVisible(p: FakePanel): void {
  p._onViewState?.({ webviewPanel: p });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeEntry(id: string) {
  return {
    estimateId: id,
    createdAt: "2026-05-27T10:14:00Z",
    queryExcerpt: "q",
    model: "m",
    host: "h",
    projectId: "p",
    scenario: "confident",
    predicted: { p10: 1, p50: 2, p90: 3 },
    actual: null,
  };
}

function ledgerPage(id: string) {
  return { entries: [makeEntry(id)], nextCursor: null };
}

function ledgerPageMulti(ids: string[], nextCursor: string | null) {
  return { entries: ids.map(makeEntry), nextCursor };
}

let activePanel: FakePanel | undefined;

beforeEach(() => {
  process.env.BUDGETARY_API_KEY = "bg_test_dashboard";
  ctl.reset();
});

afterEach(() => {
  // Reset the module's `panel` singleton between tests by simulating disposal.
  if (activePanel?._onDispose) activePanel._onDispose();
  activePanel = undefined;
  delete process.env.BUDGETARY_API_KEY;
});

describe("dashboard load sequencing", () => {
  it("a stale load does not overwrite a newer one", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // module panel = fp; fires initial load (deferreds[0])
    ctl.deferreds[0]!.resolve(ledgerPage("est_initial"));
    await tick();

    const older = load(fp); // deferreds[1]
    const newer = load(fp); // deferreds[2]

    // Newer resolves first...
    ctl.deferreds[2]!.resolve(ledgerPage("est_new"));
    await newer;
    // ...then the older (now stale) load resolves — it must NOT clobber the newer.
    ctl.deferreds[1]!.resolve(ledgerPage("est_old"));
    await older;

    expect(fp._html).toContain("est_new");
    expect(fp._html).not.toContain("est_old");
  });

  it("a manual refresh keeps the current view instead of blanking to Loading", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // deferreds[0]
    ctl.deferreds[0]!.resolve(ledgerPage("est_initial"));
    await tick();
    expect(fp._html).toContain("est_initial");

    // Manual refresh: no "Loading…" interstitial; prior content stays up.
    const refreshing = load(fp, { isRefresh: true }); // deferreds[1]
    expect(fp._html).not.toContain("Loading your ledger");
    expect(fp._html).toContain("est_initial");

    ctl.deferreds[1]!.resolve(ledgerPage("est_ref2"));
    await refreshing;
    expect(fp._html).toContain("est_ref2");
  });

  it("Load older fetches the next page, dedup-appends, and threads the new cursor", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // deferreds[0]
    // Initial page has a next cursor → the "Load older" control renders.
    ctl.deferreds[0]!.resolve(ledgerPageMulti(["est_1", "est_2"], "cursor_1"));
    await tick();
    expect(fp._html).toContain("est_1");
    expect(fp._html).toContain('id="load-older"');

    // Load older: the next page overlaps est_2 (cursor pages shift) and adds
    // est_3, and reports no further pages (nextCursor null).
    const more = load(fp, { loadMore: true }); // deferreds[1]
    ctl.deferreds[1]!.resolve(ledgerPageMulti(["est_2", "est_3"], null));
    await more;

    expect(fp._html).toContain("est_3"); // appended
    // Deduped: est_2 is rendered exactly once, not twice.
    expect((fp._html.match(/>est_2</g) ?? []).length).toBe(1);
    // No more pages → the control is gone.
    expect(fp._html).not.toContain('id="load-older"');
  });

  it("a stale Load older (older cursor) does not clobber a newer refresh", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // deferreds[0]
    ctl.deferreds[0]!.resolve(ledgerPageMulti(["est_1"], "cursor_1"));
    await tick();

    const older = load(fp, { loadMore: true }); // deferreds[1]
    const newer = load(fp, { isRefresh: true }); // deferreds[2]
    ctl.deferreds[2]!.resolve(ledgerPageMulti(["est_fresh"], null));
    await newer;
    // The stale load-older resolves last; it must neither render nor corrupt state.
    ctl.deferreds[1]!.resolve(ledgerPageMulti(["est_stale"], "cursor_2"));
    await older;

    expect(fp._html).toContain("est_fresh");
    expect(fp._html).not.toContain("est_stale");
  });

  it("renders the configure-key panel on an auth error (not a generic error)", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // deferreds[0]
    ctl.deferreds[0]!.reject(
      new BudgetaryAuthError({
        code: "authentication_failed",
        message: "key rejected",
        httpStatus: 401,
        requestId: "r",
      }),
    );
    await tick();

    expect(fp._html).toContain("No API key configured");
    expect(fp._html).toContain('id="refresh"');
    expect(fp._html).not.toContain("Could not load ledger");
  });

  it("shows an honest error on a malformed ledger page (entries not an array)", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // deferreds[0]
    // A wrong-shape 2xx: `entries` is not an array. It must read as an honest
    // "unexpected response", never throw out of the renderer.
    ctl.deferreds[0]!.resolve({ entries: "nope", nextCursor: null });
    await tick();

    expect(fp._html).toContain("unexpected response");
    expect(fp._html).toContain("Could not load ledger");
  });

  it("a load resolving after the panel is disposed neither writes nor throws", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // deferreds[0]
    const lp = load(fp); // deferreds[1]; writes the loading state synchronously
    expect(fp._html).toContain("Loading");

    // Dispose: the module's onDidDispose handler clears `panel`; VS Code would
    // now throw on any html set.
    fp._onDispose!();
    fp._disposed = true;

    ctl.deferreds[1]!.resolve(ledgerPage("est_after"));
    ctl.deferreds[0]!.resolve(ledgerPage("est_initial"));

    await expect(lp).resolves.toBeUndefined(); // guard prevented the throwing write
    expect(fp._html).not.toContain("est_after");
    activePanel = undefined; // already disposed
  });
});

describe("dashboard view-state re-render (L-2: no retainContextWhenHidden)", () => {
  it("creates the webview WITHOUT retainContextWhenHidden", () => {
    const fp = makeFakePanel();
    activePanel = fp;
    let capturedOpts: Record<string, unknown> | undefined;
    vscodeStub.window.createWebviewPanel = ((
      _id: string,
      _title: string,
      _col: unknown,
      opts: Record<string, unknown>,
    ) => {
      capturedOpts = opts;
      return fp;
    }) as typeof vscodeStub.window.createWebviewPanel;

    showDashboard({} as never);

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.enableScripts).toBe(true);
    // The flag we dropped: retaining the hidden webview is exactly what L-2 removes.
    expect(capturedOpts!.retainContextWhenHidden).toBeUndefined();
  });

  it("re-renders the dashboard from held state when the panel returns to view, with NO re-fetch", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // deferreds[0]
    ctl.deferreds[0]!.resolve(ledgerPage("est_held"));
    await tick();
    expect(fp._html).toContain("est_held");
    const fetchesAfterLoad = ctl.deferreds.length; // one getLedger so far

    // The webview is torn down while hidden (no retainContextWhenHidden): blank it,
    // then simulate it returning to view.
    fp._html = "";
    fireViewStateVisible(fp);

    // Restored from the held pagination state — and crucially WITHOUT a new fetch.
    expect(fp._html).toContain("est_held");
    expect(ctl.deferreds.length).toBe(fetchesAfterLoad);
  });

  it("does NOT re-render a dashboard over a non-dashboard view (configure panel stays)", async () => {
    const fp = makeFakePanel();
    activePanel = fp;
    vscodeStub.window.createWebviewPanel = () => fp;

    showDashboard({} as never); // deferreds[0]
    ctl.deferreds[0]!.reject(
      new BudgetaryAuthError({
        code: "authentication_failed",
        message: "key rejected",
        httpStatus: 401,
        requestId: "r",
      }),
    );
    await tick();
    expect(fp._html).toContain("No API key configured");

    // Returning to view must not clobber the configure panel with an (empty) dashboard.
    fireViewStateVisible(fp);
    expect(fp._html).toContain("No API key configured");
    expect(fp._html).not.toContain('id="b-chart-h"');
  });
});

describe("dashboard config resolution", () => {
  it("shows a distinct 'unreadable' panel when the config file can't be parsed", async () => {
    // Drive the real resolver: point HOME at a temp dir whose config.json is
    // broken JSON and unset the env key, so resolution falls through to the
    // (unreadable) file. Pre-M2 this collapsed to the "No API key configured"
    // panel; now it must be reported distinctly.
    const home = mkdtempSync(join(tmpdir(), "budgetary-vscode-cfg-"));
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(join(home, ".budgetary", "config.json"), "{ not valid json", "utf8");
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    delete process.env.BUDGETARY_API_KEY;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const fp = makeFakePanel();
      activePanel = fp;
      vscodeStub.window.createWebviewPanel = () => fp;

      showDashboard({} as never); // initial load hits the unreadable branch synchronously
      await tick();

      expect(fp._html).toContain("Config file could not be read");
      expect(fp._html).not.toContain("No API key configured");
      expect(fp._html).not.toContain("Could not load ledger");
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
