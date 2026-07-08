import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as vscodeStub from "./vscode-stub";
import { load, showDashboard } from "../src/commands/show_dashboard";

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

vi.mock("@budgetary/sdk", () => ({
  BudgetaryClient: class {
    getLedger(): Promise<unknown> {
      return ctl.next();
    }
  },
  BudgetaryError: class BudgetaryError extends Error {},
}));

interface FakePanel {
  _disposed: boolean;
  _html: string;
  _onDispose?: () => void;
  webview: { html: string; onDidReceiveMessage: (cb: (m: unknown) => void) => unknown };
  onDidDispose: (cb: () => void) => unknown;
  reveal: () => void;
  dispose: () => void;
}

function makeFakePanel(): FakePanel {
  const p = {
    _disposed: false,
    _html: "",
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
    reveal() {},
    dispose() {},
  } as unknown as FakePanel;
  return p;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function ledgerPage(id: string) {
  return {
    entries: [
      {
        estimateId: id,
        createdAt: "2026-05-27T10:14:00Z",
        queryExcerpt: "q",
        model: "m",
        host: "h",
        projectId: "p",
        scenario: "confident",
        predicted: { p10: 1, p50: 2, p90: 3 },
        actual: null,
      },
    ],
    nextCursor: null,
  };
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
