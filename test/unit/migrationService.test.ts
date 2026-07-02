import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MigrationService, type MigrationServiceDeps } from "../../src/services/migrationService";
import { extractFunctionBody } from "../../src/core/parser";
import type { UiPrefs } from "../../src/protocol/messages";

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKEN_VERSIONS_DIR = path.join(here, "../../fixtures/broken-project/alembic/versions");
const BROKEN_ENV_PY = path.join(here, "../../fixtures/broken-project/alembic/env.py");

/** Reads every *.py file in the broken-project fixture's versions dir from real disk. */
function loadBrokenFiles(): { path: string; content: string }[] {
  const files = readdirSync(BROKEN_VERSIONS_DIR).filter((f) => f.endsWith(".py"));
  return files.map((file) => ({
    path: path.join(BROKEN_VERSIONS_DIR, file),
    content: readFileSync(path.join(BROKEN_VERSIONS_DIR, file), "utf8"),
  }));
}

const DEFAULT_CONFIG = { laneColorA: "#4aa3ff", laneColorB: "#c586c0", showSqlPreview: true, collapseThreshold: 20 };
const DEFAULT_UI: UiPrefs = { order: "newest-bottom", density: "comfortable", expandCollapsed: false };
const DEFAULT_PROJECT = { label: "payments-api / alembic", iniPath: "/proj/alembic.ini" };

type ServiceConfig = ReturnType<MigrationServiceDeps["getConfig"]>;

interface FakeDeps extends MigrationServiceDeps {
  listVersionFiles: ReturnType<typeof vi.fn<() => Promise<{ path: string; content: string }[]>>>;
  getConfig: ReturnType<typeof vi.fn<() => ServiceConfig>>;
  getUiPrefs: ReturnType<typeof vi.fn<() => UiPrefs>>;
  setUiPrefs: ReturnType<typeof vi.fn<(prefs: UiPrefs) => void>>;
  log: ReturnType<typeof vi.fn<(line: string) => void>>;
}

/** Builds a fully-spied MigrationServiceDeps. getUiPrefs/setUiPrefs share mutable state, like a
 * real workspaceState-backed implementation would. */
function makeDeps(overrides: Partial<MigrationServiceDeps> = {}): FakeDeps {
  let ui: UiPrefs = { ...DEFAULT_UI };
  const deps = {
    listVersionFiles: vi.fn(async () => loadBrokenFiles()),
    getConfig: vi.fn(() => ({ ...DEFAULT_CONFIG })),
    getUiPrefs: vi.fn(() => ui),
    setUiPrefs: vi.fn((prefs: UiPrefs) => {
      ui = prefs;
    }),
    log: vi.fn(),
    project: { ...DEFAULT_PROJECT },
    ...overrides,
  } as FakeDeps;
  return deps;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MigrationService.refresh", () => {
  it("1. builds an AppState from the broken-project fixture with expected counts and layout", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);

    await service.refresh();
    const state = service.getState();

    expect(state).not.toBeNull();
    expect(state!.counts).toEqual({ revisions: 12, heads: 3, problems: 1 });
    expect(state!.dbReachable).toBe(false);
    expect(state!.currentIds).toEqual([]);
    expect(state!.layout.nodes).toHaveLength(13); // 12 revisions + 1 ghost (deadbeef0000)
    expect(state!.laneColors).toEqual(["#4aa3ff", "#c586c0"]);
    expect(state!.project).toEqual(DEFAULT_PROJECT);
    expect(state!.ui).toEqual(DEFAULT_UI);
  });

  it("2. skips an env.py-like file in the list without throwing", async () => {
    const envContent = readFileSync(BROKEN_ENV_PY, "utf8");
    const deps = makeDeps({
      listVersionFiles: vi.fn(async () => [...loadBrokenFiles(), { path: BROKEN_ENV_PY, content: envContent }]),
    });
    const service = new MigrationService(deps);

    await service.refresh();
    const state = service.getState();

    expect(state).not.toBeNull();
    expect(state!.counts.revisions).toBe(12); // env.py contributes nothing
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("error"));
  });

  it("6. a listVersionFiles rejection logs the error and retains the previous state without emitting", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();
    const prevState = service.getState();

    deps.listVersionFiles.mockRejectedValueOnce(new Error("boom: disk unmounted"));
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh();

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("boom: disk unmounted"));
    expect(listener).not.toHaveBeenCalled();
    expect(service.getState()).toBe(prevState); // same reference: untouched
  });

  it("7. a refresh() call while one is in flight queues exactly one trailing refresh reflecting the latest data", async () => {
    const allFiles = loadBrokenFiles();
    // 3aebf1885b7d is a head with no children pointing at it — dropping it removes exactly one
    // revision and one head without creating any new broken link.
    const fewerFiles = allFiles.filter((f) => !f.path.endsWith("3aebf1885b7d_add_rate_limiting.py"));

    let calls = 0;
    const listVersionFiles = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? allFiles : fewerFiles;
    });
    const deps = makeDeps({ listVersionFiles });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    const p1 = service.refresh();
    const p2 = service.refresh(); // fired while p1 is still in flight -> should queue, not start a 2nd concurrent read

    expect(listVersionFiles).toHaveBeenCalledTimes(1); // trailing refresh hasn't started yet

    await Promise.all([p1, p2]);

    expect(listVersionFiles).toHaveBeenCalledTimes(2); // exactly one trailing refresh ran
    expect(listener.mock.calls.length).toBe(2);
    expect(listener.mock.calls[0][0].counts.revisions).toBe(12);
    expect(listener.mock.calls[1][0].counts.revisions).toBe(11); // last emit reflects the latest data
    expect(service.getState()!.counts.revisions).toBe(11);
  });
});

describe("MigrationService.scheduleRefresh", () => {
  it("3. coalesces 5 calls within the debounce window into exactly 1 listVersionFiles call", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const service = new MigrationService(deps);

    service.scheduleRefresh();
    service.scheduleRefresh();
    service.scheduleRefresh();
    service.scheduleRefresh();
    service.scheduleRefresh();

    await vi.advanceTimersByTimeAsync(300);

    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("8. implements per-call-RESETTING debounce semantics: a second call restarts the 300ms window", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const service = new MigrationService(deps);

    // First call starts the debounce window
    service.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(200);

    // No refresh yet (window not closed)
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(0);

    // Second call RESETS the window
    service.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(200);

    // Still no refresh (200ms from second call, window needs 300ms total)
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(0);

    // Advance 100ms more (300ms from second call)
    await vi.advanceTimersByTimeAsync(100);

    // Now exactly one refresh fired
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});

describe("MigrationService.setExpandCollapsed", () => {
  it("4. re-lays out from the cached graph and re-emits WITHOUT re-reading files", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1);

    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.setExpandCollapsed(true);

    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1); // unchanged
    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.ui.expandCollapsed).toBe(true);
    expect(deps.setUiPrefs).toHaveBeenCalledWith(expect.objectContaining({ expandCollapsed: true }));
  });
});

describe("MigrationService.setOrder / setDensity", () => {
  it("5a. setOrder emits updated ui, persists prefs, and leaves the layout object reference unchanged", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();
    const layoutBefore = service.getState()!.layout;

    const listener = vi.fn();
    service.onDidChangeState(listener);
    service.setOrder("newest-top");

    expect(deps.setUiPrefs).toHaveBeenCalledWith(expect.objectContaining({ order: "newest-top" }));
    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.ui.order).toBe("newest-top");
    expect(newState.layout).toBe(layoutBefore); // same reference: no re-layout
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1); // no re-read
  });

  it("5b. setDensity emits updated ui, persists prefs, and leaves the layout object reference unchanged", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();
    const layoutBefore = service.getState()!.layout;

    const listener = vi.fn();
    service.onDidChangeState(listener);
    service.setDensity("compact");

    expect(deps.setUiPrefs).toHaveBeenCalledWith(expect.objectContaining({ density: "compact" }));
    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.ui.density).toBe("compact");
    expect(newState.layout).toBe(layoutBefore);
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1);
  });
});

describe("MigrationService edge cases (self-review)", () => {
  it("getState() is null before the first refresh", () => {
    const service = new MigrationService(makeDeps());
    expect(service.getState()).toBeNull();
  });

  it("onDidChangeState().dispose() stops further notifications", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    const listener = vi.fn();
    const sub = service.onDidChangeState(listener);
    sub.dispose();

    await service.refresh();

    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose() cancels a pending debounce so no refresh ever fires", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const service = new MigrationService(deps);

    service.scheduleRefresh();
    service.dispose();
    await vi.advanceTimersByTimeAsync(1000);

    expect(deps.listVersionFiles).not.toHaveBeenCalled();
  });

  it("setOrder/setDensity/setExpandCollapsed before any refresh do not throw and do not emit", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    service.setOrder("newest-top");
    service.setDensity("compact");
    await service.setExpandCollapsed(true);

    expect(listener).not.toHaveBeenCalled();
    expect(service.getState()).toBeNull();
  });
});

describe("MigrationService.getDetail", () => {
  it("returns null before any refresh has completed", () => {
    const service = new MigrationService(makeDeps());
    expect(service.getDetail("8f2a1c9d4e07")).toBeNull();
  });

  it("known id (a root revision): full detail with real upgrade/downgrade body text from its fixture file, downRevisions []", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();

    const detail = service.getDetail("8f2a1c9d4e07");
    expect(detail).not.toBeNull();

    const rawContent = readFileSync(
      path.join(BROKEN_VERSIONS_DIR, "8f2a1c9d4e07_create_products_table.py"),
      "utf8",
    );
    // Cross-checked against the real parser (not re-derived by hand) so this doesn't silently
    // drift if the fixture file changes, while still asserting real, non-empty body text below.
    expect(detail!.upgradeBody).toBe(extractFunctionBody(rawContent, "upgrade"));
    expect(detail!.downgradeBody).toBe(extractFunctionBody(rawContent, "downgrade"));
    expect(detail!.upgradeBody).toContain("op.create_table(");
    expect(detail!.upgradeBody).toContain("'products'");
    expect(detail!.downgradeBody).toBe("op.drop_table('products')");

    expect(detail).toMatchObject({
      id: "8f2a1c9d4e07",
      hash: "8f2a1c9d4e07",
      message: "create products table",
      author: null,
      date: "2026-05-01 10:01:00.000000",
      applied: null, // appliedSet is always null pre-Task 13
      isCurrent: false,
      isHead: false,
      isMerge: false,
      isBroken: false,
      branchLabel: null,
      downRevisions: [],
    });
    expect(detail!.filePath).toContain("8f2a1c9d4e07_create_products_table.py");
  });

  it("a broken child lists its missing down_revision with missing: true", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();

    const detail = service.getDetail("5c0d13aa7d9f");
    expect(detail).not.toBeNull();
    expect(detail!.isBroken).toBe(true);
    expect(detail!.downRevisions).toEqual([{ id: "deadbeef0000", missing: true }]);
  });

  it("a merge node has two non-missing downRevisions (in source order) and 'pass' bodies", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();

    const detail = service.getDetail("29dae0774a6c");
    expect(detail).not.toBeNull();
    expect(detail!.isMerge).toBe(true);
    expect(detail!.downRevisions).toEqual([
      { id: "18c9d9663f5b", missing: false },
      { id: "07b8c8552e4a", missing: false },
    ]);
    expect(detail!.upgradeBody).toBe("pass");
    expect(detail!.downgradeBody).toBe("pass");
  });

  it("showSqlPreview: false yields null upgrade/downgrade bodies (both, not just one)", async () => {
    const deps = makeDeps({ getConfig: vi.fn(() => ({ ...DEFAULT_CONFIG, showSqlPreview: false })) });
    const service = new MigrationService(deps);
    await service.refresh();

    const detail = service.getDetail("29dae0774a6c");
    expect(detail).not.toBeNull();
    expect(detail!.upgradeBody).toBeNull();
    expect(detail!.downgradeBody).toBeNull();
  });

  it("re-reads showSqlPreview live at call time, not the value captured at last refresh", async () => {
    let showSqlPreview = true;
    const deps = makeDeps({ getConfig: vi.fn(() => ({ ...DEFAULT_CONFIG, showSqlPreview })) });
    const service = new MigrationService(deps);
    await service.refresh(); // scanned while showSqlPreview was true

    showSqlPreview = false; // flipped without a re-refresh
    const detail = service.getDetail("29dae0774a6c");
    expect(detail!.upgradeBody).toBeNull();
    expect(detail!.downgradeBody).toBeNull();
  });

  it("unknown id returns null", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();

    expect(service.getDetail("not-a-real-revision-id")).toBeNull();
  });

  it("a ghost id (referenced by a broken child but no file of its own) returns null", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();

    expect(service.getDetail("deadbeef0000")).toBeNull();
  });
});
