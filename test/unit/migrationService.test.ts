import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MigrationService, type MigrationServiceDeps } from "../../src/services/migrationService";
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
