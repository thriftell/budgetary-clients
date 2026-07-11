import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ActualsResponse,
  EstimateResponse,
  LedgerPage,
} from "@budgetary/sdk";
import {
  BudgetaryAuthError,
  BudgetaryError,
  BudgetaryRateLimitError,
} from "@budgetary/sdk";

import { projectIdFromCwd, runEstimateTool } from "../src/tools/estimate.js";

interface FakeClient {
  estimate: ReturnType<typeof vi.fn>;
  submitActuals: ReturnType<typeof vi.fn>;
  getLedger: ReturnType<typeof vi.fn>;
}

function makeFakeClient(
  estimateImpl: (...args: unknown[]) => Promise<EstimateResponse>,
): FakeClient {
  return {
    estimate: vi.fn(estimateImpl),
    submitActuals: vi.fn(
      async (): Promise<ActualsResponse> => ({
        received: true,
        ledgerEntryId: "led_1",
      }),
    ),
    getLedger: vi.fn(
      async (): Promise<LedgerPage> => ({ entries: [], nextCursor: null }),
    ),
  };
}

function happyEstimate(): EstimateResponse {
  return {
    estimateId: "est_01ABC",
    scenario: "confident",
    void: false,
    distribution: { p10: 12500, p50: 48000, p90: 220000, unit: "tokens" },
    confidence: 0.74,
    model: "claude-opus-4-7",
    expiresAt: "2026-05-27T10:14:00Z",
  };
}

function voidEstimate(): EstimateResponse {
  return {
    estimateId: "est_void",
    scenario: "out_of_domain",
    void: true,
    distribution: null,
    confidence: 0,
    model: "claude-opus-4-7",
    expiresAt: "2026-05-27T10:14:00Z",
  };
}

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "budgetary-home-"));
  cwd = mkdtempSync(join(tmpdir(), "budgetary-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const asClient = (fake: FakeClient) =>
  fake as unknown as import("@budgetary/sdk").BudgetaryClient;

describe("projectIdFromCwd — salted, per-install, non-reversible", () => {
  it("is stable across runs for one install, 16-hex, and never the raw path", () => {
    const a = projectIdFromCwd(cwd, home);
    const b = projectIdFromCwd(cwd, home); // a later run, same install salt
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain(cwd);
  });

  it("differs across installs (distinct salt) for the same working directory", () => {
    const home2 = mkdtempSync(join(tmpdir(), "budgetary-home2-"));
    try {
      expect(projectIdFromCwd(cwd, home)).not.toBe(projectIdFromCwd(cwd, home2));
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });

  it("persists the install salt owner-only (no group/other access)", () => {
    projectIdFromCwd(cwd, home);
    const saltPath = join(home, ".budgetary", "install-salt");
    expect(existsSync(saltPath)).toBe(true);
    // The salt is a machine-local secret — it must not be group/world readable.
    expect(statSync(saltPath).mode & 0o077).toBe(0);
  });

  it("self-heals a malformed install-salt so the id stays stable across runs", () => {
    // A truncated / garbage salt file (e.g. left by a crash mid-write) must not
    // make project_id churn every run — that would silently break the
    // estimate↔actuals binding. It is repaired in place instead.
    const saltPath = join(home, ".budgetary", "install-salt");
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(saltPath, "not-valid-hex", "utf8");

    const a = projectIdFromCwd(cwd, home);
    const b = projectIdFromCwd(cwd, home); // a later run, same install
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    // The unusable file was repaired to a valid, persisted 32-byte salt.
    expect(readFileSync(saltPath, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stays stable via a deterministic fallback when the salt cannot be persisted", () => {
    // A directory sitting at the salt path can be neither created (wx) nor
    // removed (unlink), so no per-install secret can be stored. project_id must
    // still be STABLE across runs (deterministic fallback), so binding survives.
    mkdirSync(join(home, ".budgetary", "install-salt"), { recursive: true });
    const a = projectIdFromCwd(cwd, home);
    const b = projectIdFromCwd(cwd, home);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("runEstimateTool — happy path", () => {
  it("threads host from BUDGETARY_HOST, passes query+model, appends pending, renders result", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    const result = await runEstimateTool({
      query: "fix the flaky test",
      model: "claude-sonnet-4-6",
      env: {
        BUDGETARY_API_KEY: "bg_test_dummy",
        BUDGETARY_HOST: "claude-code",
      } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
      now: () => new Date("2026-05-27T10:14:00Z"),
    });

    expect(result.isError).toBe(false);
    expect(fake.estimate).toHaveBeenCalledTimes(1);
    const [query, opts] = fake.estimate.mock.calls[0]!;
    expect(query).toBe("fix the flaky test");
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.context.host).toBe("claude-code");
    expect(opts.context.projectId).toMatch(/^[0-9a-f]{16}$/);

    // Confident → point-led, but the range is always shown (band, not a point).
    expect(result.text).toContain("Estimated cost:");
    expect(result.text).toContain("48,000");
    expect(result.text).toContain("12,500–220,000");
    expect(result.text).toContain("p10–p90");
    expect(result.text).toContain("Scenario: confident");
    expect(result.text).toContain("Pending estimate stored");
    // Never leak the key.
    expect(result.text).not.toContain("bg_test_dummy");

    const file = JSON.parse(
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    );
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].estimate_id).toBe("est_01ABC");
    expect(file.entries[0].attempts).toBe(0);
    expect(file.entries[0].query).toBe("fix the flaky test");
  });

  it("defaults host to \"mcp\" when BUDGETARY_HOST is unset", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    await runEstimateTool({
      query: "anything",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    const [, opts] = fake.estimate.mock.calls[0]!;
    expect(opts.context.host).toBe("mcp");
  });
});

describe("runEstimateTool — malformed 2xx never throws out of the tool (P-C1)", () => {
  it("surfaces graceful error text (not a raw TypeError) on a wrong-shape response", async () => {
    // The SDK now shape-validates the estimate body; this exercises the tool's
    // belt-and-suspenders wrap directly — a fake client returns a malformed
    // response (distribution is a string, not an object), so renderEstimate would
    // throw a raw TypeError without the wrap.
    const malformed = {
      estimateId: "est_bad",
      scenario: "confident",
      void: false,
      distribution: "oops-not-an-object",
      confidence: 0.5,
      model: "m",
      expiresAt: "t",
    } as unknown as EstimateResponse;
    const fake = makeFakeClient(async () => malformed);

    const result = await runEstimateTool({
      query: "q",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    // Graceful text + isError, never a thrown exception.
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Budgetary couldn't be reached");
  });

  it("stores NO pending entry when the SDK rejects a garbage body as a network error", async () => {
    // In production the SDK's validator throws before the response reaches the
    // tool; that path returns graceful text and must store nothing.
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({
        code: "network",
        message: "unusable response body from Budgetary API (missing estimateId)",
        httpStatus: null,
        requestId: null,
      });
    });

    const result = await runEstimateTool({
      query: "q",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(existsSync(join(home, ".budgetary", "pending.json"))).toBe(false);
  });
});

describe("runEstimateTool — void", () => {
  it("renders the void message and does NOT write a pending entry", async () => {
    const fake = makeFakeClient(async () => voidEstimate());

    const result = await runEstimateTool({
      query: "???",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("cannot confidently estimate");
    expect(() =>
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    ).toThrow();
  });
});

describe("runEstimateTool — no API key", () => {
  it("returns configure-key guidance and does NOT call the SDK or throw", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    const result = await runEstimateTool({
      query: "anything",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(false);
    expect(fake.estimate).not.toHaveBeenCalled();
    expect(result.text).toContain("no API key");
    expect(result.text).toContain("BUDGETARY_API_KEY");
  });
});

describe("runEstimateTool — 403 subscription gate", () => {
  it("renders a subscription-required message, distinct from 401, not thrown", async () => {
    const fake = makeFakeClient(async () => {
      throw new BudgetaryAuthError({
        code: "permission_denied",
        message: "key lacks scope",
        httpStatus: 403,
        requestId: "req_403",
      });
    });

    const result = await runEstimateTool({
      query: "needs a plan",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("active plan");
    expect(result.text).toContain("https://budgetary.tools");
    // Must NOT be the 401 wording.
    expect(result.text).not.toContain("was rejected");
    // No pending entry on error.
    expect(() =>
      readFileSync(join(home, ".budgetary", "pending.json"), "utf8"),
    ).toThrow();
  });
});

describe("runEstimateTool — transport error surfaces the retry ordeal (O-6)", () => {
  it("renders 'after N attempts over Ns' from the error's attempts/totalElapsedMs", async () => {
    // A 5xx that exhausted the ladder: the SDK stamps attempts/totalElapsedMs; the
    // estimate tool must forward them into renderTransportError (the wiring).
    const err = new BudgetaryError({
      code: "unavailable",
      message: "upstream down",
      httpStatus: 503,
      requestId: "req_x",
    });
    err.attempts = 5;
    err.totalElapsedMs = 240000;
    const fake = makeFakeClient(async () => {
      throw err;
    });

    const result = await runEstimateTool({
      query: "estimate this",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Budgetary couldn't be reached");
    expect(result.text).toContain("after 5 attempts over 240s");
    expect(result.text).toContain("(request_id: req_x)");
  });
});

describe("runEstimateTool — 401 auth failure", () => {
  it("renders a key-rejected message distinct from the 403 wording", async () => {
    const fake = makeFakeClient(async () => {
      throw new BudgetaryAuthError({
        code: "authentication_failed",
        message: "bad key",
        httpStatus: 401,
        requestId: "req_401",
      });
    });

    const result = await runEstimateTool({
      query: "bad key",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("was rejected");
    expect(result.text).not.toContain("active plan");
  });
});

describe("runEstimateTool — 429 rate limit", () => {
  it("renders a retry-after message", async () => {
    const fake = makeFakeClient(async () => {
      throw new BudgetaryRateLimitError({
        code: "rate_limited",
        message: "slow down",
        httpStatus: 429,
        requestId: "req_429",
        retryAfterSeconds: 30,
      });
    });

    const result = await runEstimateTool({
      query: "too fast",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("rate limit");
    expect(result.text).toContain("30 seconds");
  });
});

describe("runEstimateTool — honest failures & host-aware onboarding", () => {
  it("413: renders a rejection + the fix, not 'couldn't be reached'", async () => {
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({
        code: "payload_too_large",
        message: "query exceeds 8000 characters",
        httpStatus: 413,
        requestId: "req_413",
      });
    });

    const result = await runEstimateTool({
      query: "way too long",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("rejected the request");
    expect(result.text).toContain("Shorten");
    expect(result.text).not.toContain("couldn't be reached");
  });

  it("5xx: still advises retry (couldn't be reached)", async () => {
    const fake = makeFakeClient(async () => {
      throw new BudgetaryError({
        code: "internal_error",
        message: "boom",
        httpStatus: 500,
        requestId: "req_500",
      });
    });
    const result = await runEstimateTool({
      query: "x",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });
    expect(result.text).toContain("couldn't be reached");
  });

  it("footer is host-aware: codex points at on-session-end --transcript", async () => {
    const fake = makeFakeClient(async () => happyEstimate());
    const result = await runEstimateTool({
      query: "x",
      env: { BUDGETARY_API_KEY: "bg_test_dummy", BUDGETARY_HOST: "codex" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });
    expect(result.text).toContain("on-session-end --transcript");
  });

  it("footer is host-aware: claude-code mentions the plugin, default points at report-actual", async () => {
    const fake = makeFakeClient(async () => happyEstimate());
    const cc = await runEstimateTool({
      query: "x",
      env: { BUDGETARY_API_KEY: "bg_test_dummy", BUDGETARY_HOST: "claude-code" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });
    expect(cc.text).toContain("Budgetary plugin");

    const other = await runEstimateTool({
      query: "x",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv, // host defaults to mcp
      cwd: mkdtempSync(join(tmpdir(), "budgetary-cwd2-")),
      home: mkdtempSync(join(tmpdir(), "budgetary-home2-")),
      clientFactory: () => asClient(fake),
    });
    expect(other.text).toContain("report-actual");
    expect(other.text).not.toContain("on-session-end --transcript");
  });

  it("does NOT claim 'stored' when the pending store is unwritable", async () => {
    // A foreign top-level shape makes the store unwritable (won't clobber it),
    // so append is refused and the footer must be honest.
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(join(home, ".budgetary", "pending.json"), JSON.stringify({ version: 99 }), "utf8");
    const fake = makeFakeClient(async () => happyEstimate());

    const result = await runEstimateTool({
      query: "x",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("Pending estimate stored");
    expect(result.text).toContain("Couldn't save");
  });

  it("no-key guidance is host-aware on claude-code (/plugin configure)", async () => {
    const fake = makeFakeClient(async () => happyEstimate());
    const result = await runEstimateTool({
      query: "x",
      env: { BUDGETARY_HOST: "claude-code" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });
    expect(fake.estimate).not.toHaveBeenCalled();
    expect(result.text).toContain("/plugin configure budgetary@budgetary");
  });

  it("nudges when earlier estimates for this project still await actuals", async () => {
    // Pre-seed an older pending estimate for the same project.
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "pending.json"),
      JSON.stringify({
        version: 1,
        entries: [
          { estimate_id: "est_old", query: "earlier task", project_id: projectIdFromCwd(cwd, home), created_at: "2026-05-27T09:00:00Z", attempts: 0 },
        ],
      }),
      "utf8",
    );
    const fake = makeFakeClient(async () => happyEstimate());
    const result = await runEstimateTool({
      query: "new task",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });
    expect(result.text).toContain("still await actuals");
    expect(result.text).toContain("pending");
  });

  it("distinguishes an unreadable config from no key at all", async () => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(join(home, ".budgetary", "config.json"), "{ not json", "utf8");
    const fake = makeFakeClient(async () => happyEstimate());

    const result = await runEstimateTool({
      query: "x",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });
    expect(fake.estimate).not.toHaveBeenCalled();
    expect(result.text).toContain("couldn't read it");
  });
});

describe("runEstimateTool — config file fallback", () => {
  it("reads the key from ~/.budgetary/config.json and never echoes it", async () => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "config.json"),
      JSON.stringify({ api_key: "bg_test_dummy" }),
      "utf8",
    );
    const fake = makeFakeClient(async () => happyEstimate());

    const result = await runEstimateTool({
      query: "from config file",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    expect(fake.estimate).toHaveBeenCalled();
    expect(result.text).not.toContain("bg_test_dummy");
  });
});

describe("runEstimateTool — declared language forward", () => {
  it("forwards context.language from BUDGETARY_LANGUAGE (trimmed), beside host", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    await runEstimateTool({
      query: "build a feature",
      env: {
        BUDGETARY_API_KEY: "bg_test_dummy",
        BUDGETARY_HOST: "claude-code",
        BUDGETARY_LANGUAGE: "  TypeScript  ",
      } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    const [, opts] = fake.estimate.mock.calls[0]!;
    expect(opts.context.host).toBe("claude-code");
    expect(opts.context.language).toBe("TypeScript");
  });

  it("OMITS context.language entirely when no signal exists (server stores '(none)')", async () => {
    const fake = makeFakeClient(async () => happyEstimate());

    await runEstimateTool({
      query: "anything",
      env: { BUDGETARY_API_KEY: "bg_test_dummy" } as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    const [, opts] = fake.estimate.mock.calls[0]!;
    // Omitted, not null/empty — the field must be absent from the body.
    expect("language" in opts.context).toBe(false);
  });

  it("reads context.language from ~/.budgetary/config.json when env is unset", async () => {
    mkdirSync(join(home, ".budgetary"), { recursive: true });
    writeFileSync(
      join(home, ".budgetary", "config.json"),
      JSON.stringify({ api_key: "bg_test_dummy", language: "Python" }),
      "utf8",
    );
    const fake = makeFakeClient(async () => happyEstimate());

    await runEstimateTool({
      query: "from config file",
      env: {} as NodeJS.ProcessEnv,
      cwd,
      home,
      clientFactory: () => asClient(fake),
    });

    const [, opts] = fake.estimate.mock.calls[0]!;
    expect(opts.context.language).toBe("Python");
  });
});
