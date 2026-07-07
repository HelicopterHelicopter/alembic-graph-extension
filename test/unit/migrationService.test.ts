import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MigrationService, laneColorsFor, type MigrationServiceDeps } from "../../src/services/migrationService";
import { extractFunctionBody } from "../../src/core/parser";
import type { GhostBlame, UiPrefs } from "../../src/protocol/messages";

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
const DEFAULT_UI: UiPrefs = { order: "newest-bottom", density: "comfortable", expandCollapsed: false, axis: "horizontal" };
// `state.project` only ever carries label/iniPath (see doRefresh's AppState literal) — kept
// separate from `DEFAULT_VERSIONS_DIR` below so `expect(state!.project).toEqual(DEFAULT_PROJECT)`
// isn't broken by a field the emitted state never includes.
const DEFAULT_PROJECT = { label: "payments-api / alembic", iniPath: "/proj/alembic.ini" };
const DEFAULT_VERSIONS_DIR = "/proj/versions";

type ServiceConfig = ReturnType<MigrationServiceDeps["getConfig"]>;

interface FakeDeps extends MigrationServiceDeps {
  listVersionFiles: ReturnType<typeof vi.fn<() => Promise<{ path: string; content: string }[]>>>;
  getConfig: ReturnType<typeof vi.fn<() => ServiceConfig>>;
  getUiPrefs: ReturnType<typeof vi.fn<() => UiPrefs>>;
  setUiPrefs: ReturnType<typeof vi.fn<(prefs: UiPrefs) => void>>;
  log: ReturnType<typeof vi.fn<(line: string) => void>>;
}

/** Builds a fully-spied MigrationServiceDeps. getUiPrefs/setUiPrefs share mutable state, like a
 * real workspaceState-backed implementation would. Task H: getUiPrefs merges stored values with
 * defaults to handle legacy persisted objects lacking the axis field. */
function makeDeps(overrides: Partial<MigrationServiceDeps> = {}): FakeDeps {
  let ui: UiPrefs = { ...DEFAULT_UI };
  const deps = {
    listVersionFiles: vi.fn(async () => loadBrokenFiles()),
    getConfig: vi.fn(() => ({ ...DEFAULT_CONFIG })),
    getUiPrefs: vi.fn(() => ({ ...DEFAULT_UI, ...ui })),
    setUiPrefs: vi.fn((prefs: UiPrefs) => {
      ui = prefs;
    }),
    log: vi.fn(),
    project: { ...DEFAULT_PROJECT, versionsDir: DEFAULT_VERSIONS_DIR },
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

  it("1b. invalid laneColorA/laneColorB from getConfig fall back to hardcoded defaults in emitted state", async () => {
    const deps = makeDeps({
      getConfig: vi.fn(() => ({ ...DEFAULT_CONFIG, laneColorA: "javascript:alert(1)", laneColorB: "<script>" })),
    });
    const service = new MigrationService(deps);

    await service.refresh();
    const state = service.getState();

    expect(state!.laneColors).toEqual(["#4aa3ff", "#c586c0"]);
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

describe("MigrationService.applyConfigChange (Task 21 config live-reload)", () => {
  const CURRENT_ID = "d4c7f5309b2e";

  it("a. no-op before any refresh: no throw, no emit", () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    service.applyConfigChange();

    expect(listener).not.toHaveBeenCalled();
    expect(service.getState()).toBeNull();
  });

  it("b. re-derives laneColors/config.showSqlPreview from a fresh getConfig() read, WITHOUT re-reading files", async () => {
    let config = { ...DEFAULT_CONFIG };
    const deps = makeDeps({ getConfig: vi.fn(() => ({ ...config })) });
    const service = new MigrationService(deps);
    await service.refresh();
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1);

    const listener = vi.fn();
    service.onDidChangeState(listener);

    config = { ...config, laneColorA: "#ff8800", showSqlPreview: false };
    service.applyConfigChange();

    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1); // unchanged: no re-read
    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.laneColors).toEqual(["#ff8800", "#c586c0"]);
    expect(newState.config).toEqual({ showSqlPreview: false });
    expect(service.getState()).toBe(newState);
  });

  it("c. does NOT reset already-known dbReachable/applied/current state (unlike a full refresh())", async () => {
    const deps = makeDeps({
      fetchCurrent: vi.fn(async () => ({ dbReachable: true, currentIds: [CURRENT_ID] })),
    });
    const service = new MigrationService(deps);
    await service.refresh();
    await flushMicrotasks();
    expect(service.getState()!.dbReachable).toBe(true);

    service.applyConfigChange();

    const state = service.getState()!;
    expect(state.dbReachable).toBe(true);
    expect(state.currentIds).toEqual([CURRENT_ID]);
    const node = state.layout.nodes.find((n) => n.id === CURRENT_ID);
    expect(node).toMatchObject({ applied: true, isCurrent: true });
  });

  it("d. does NOT re-fire fetchCurrent or fetchAuthors (cheap: no CLI/git work for a config-only change)", async () => {
    const fetchCurrent = vi.fn(async () => ({ dbReachable: true, currentIds: [] }));
    const fetchAuthors = vi.fn(async () => new Map<string, string>());
    const deps = makeDeps({ fetchCurrent, fetchAuthors });
    const service = new MigrationService(deps);
    await service.refresh();
    await flushMicrotasks();
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
    expect(fetchAuthors).toHaveBeenCalledTimes(1);

    service.applyConfigChange();
    await flushMicrotasks();

    expect(fetchCurrent).toHaveBeenCalledTimes(1); // still just the one from refresh()
    expect(fetchAuthors).toHaveBeenCalledTimes(1);
  });

  it("e. preserves already-known authors across a config change", async () => {
    const ROOT_FILE_PATH = path.join(BROKEN_VERSIONS_DIR, "8f2a1c9d4e07_create_products_table.py");
    const deps = makeDeps({
      fetchAuthors: vi.fn(async () => new Map([[ROOT_FILE_PATH, "Ada Lovelace"]])),
    });
    const service = new MigrationService(deps);
    await service.refresh();
    await flushMicrotasks();
    expect(service.getState()!.layout.nodes.find((n) => n.id === "8f2a1c9d4e07")!.author).toBe("Ada Lovelace");

    service.applyConfigChange();

    expect(service.getState()!.layout.nodes.find((n) => n.id === "8f2a1c9d4e07")!.author).toBe("Ada Lovelace");
  });

  it("f. a changed collapseThreshold re-collapses the layout from the cached graph", async () => {
    let config = { ...DEFAULT_CONFIG };
    const deps = makeDeps({ getConfig: vi.fn(() => ({ ...config })) });
    const service = new MigrationService(deps);
    await service.refresh();
    const before = service.getState()!.layout.collapsed;
    expect(before).toBeNull(); // threshold 20, fixture too small to collapse

    config = { ...config, collapseThreshold: 3 };
    service.applyConfigChange();

    const after = service.getState()!.layout.collapsed;
    expect(after).not.toBeNull(); // a small threshold now collapses a run
  });
});

describe("MigrationService.dispose (Task 21: mid-flight disposal)", () => {
  it("a scan already in flight when dispose() is called never builds/emits/logs afterward", async () => {
    const pending = deferred<{ path: string; content: string }[]>();
    const deps = makeDeps({ listVersionFiles: vi.fn(() => pending.promise) });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    const refreshPromise = service.refresh();
    service.dispose();

    pending.resolve(loadBrokenFiles());
    await refreshPromise;
    await flushMicrotasks();

    expect(listener).not.toHaveBeenCalled(); // dispose() cleared listeners anyway, but also...
    expect(service.getState()).toBeNull(); // ...the scan itself bailed and never built/set state
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("scan:"));
  });

  it("does not fire fetchCurrent/fetchAuthors for a scan that resolves after dispose()", async () => {
    const pending = deferred<{ path: string; content: string }[]>();
    const fetchCurrent = vi.fn(async () => ({ dbReachable: true, currentIds: [] }));
    const fetchAuthors = vi.fn(async () => new Map<string, string>());
    const deps = makeDeps({ listVersionFiles: vi.fn(() => pending.promise), fetchCurrent, fetchAuthors });
    const service = new MigrationService(deps);

    const refreshPromise = service.refresh();
    service.dispose();

    pending.resolve(loadBrokenFiles());
    await refreshPromise;
    await flushMicrotasks();

    expect(fetchCurrent).not.toHaveBeenCalled();
    expect(fetchAuthors).not.toHaveBeenCalled();
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

  it("5c. setAxis emits updated ui, persists prefs, and leaves the layout object reference unchanged", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();
    const layoutBefore = service.getState()!.layout;

    const listener = vi.fn();
    service.onDidChangeState(listener);
    service.setAxis("vertical");

    expect(deps.setUiPrefs).toHaveBeenCalledWith(expect.objectContaining({ axis: "vertical" }));
    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.ui.axis).toBe("vertical");
    expect(newState.layout).toBe(layoutBefore); // same reference: no re-layout
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1); // no re-read
  });
});

describe("MigrationService.applyUiPrefs", () => {
  it("a. order-only change: one emit, layout reference unchanged, setUiPrefs called", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();
    const layoutBefore = service.getState()!.layout;

    const listener = vi.fn();
    service.onDidChangeState(listener);
    await service.applyUiPrefs({ order: "newest-top" });

    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.ui.order).toBe("newest-top");
    expect(newState.layout).toBe(layoutBefore); // same reference: no re-layout
    expect(deps.setUiPrefs).toHaveBeenCalledWith(expect.objectContaining({ order: "newest-top" }));
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1); // no re-read
  });

  it("b. expandCollapsed change: one emit, re-layout from cache (no listVersionFiles call)", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();
    const layoutBefore = service.getState()!.layout;

    const listener = vi.fn();
    service.onDidChangeState(listener);
    await service.applyUiPrefs({ expandCollapsed: true });

    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1); // unchanged: re-layout from cache, not a re-read
    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.ui.expandCollapsed).toBe(true);
    expect(newState.layout).not.toBe(layoutBefore); // re-laid-out
    expect(deps.setUiPrefs).toHaveBeenCalledWith(expect.objectContaining({ expandCollapsed: true }));
  });

  it("c. identical prefs: zero emits", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();

    const listener = vi.fn();
    service.onDidChangeState(listener);
    await service.applyUiPrefs({ ...DEFAULT_UI }); // already the current prefs

    expect(listener).not.toHaveBeenCalled();
    expect(deps.setUiPrefs).not.toHaveBeenCalled();
  });

  it("d. all four changed at once: exactly one emit with all applied", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();

    const listener = vi.fn();
    service.onDidChangeState(listener);
    await service.applyUiPrefs({ order: "newest-top", density: "compact", expandCollapsed: true, axis: "vertical" });

    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.ui).toEqual({ order: "newest-top", density: "compact", expandCollapsed: true, axis: "vertical" });
    expect(deps.setUiPrefs).toHaveBeenCalledTimes(1);
    expect(deps.setUiPrefs).toHaveBeenCalledWith({
      order: "newest-top",
      density: "compact",
      expandCollapsed: true,
      axis: "vertical",
    });
  });

  it("e. axis-only change: one emit, layout reference unchanged, setUiPrefs called", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();
    const layoutBefore = service.getState()!.layout;

    const listener = vi.fn();
    service.onDidChangeState(listener);
    await service.applyUiPrefs({ axis: "vertical" });

    expect(listener).toHaveBeenCalledTimes(1);
    const newState = listener.mock.calls[0][0];
    expect(newState.ui.axis).toBe("vertical");
    expect(newState.layout).toBe(layoutBefore); // same reference: no re-layout
    expect(deps.setUiPrefs).toHaveBeenCalledWith(expect.objectContaining({ axis: "vertical" }));
    expect(deps.listVersionFiles).toHaveBeenCalledTimes(1); // no re-read
  });
});

describe("MigrationService edge cases (self-review)", () => {
  it("getState() is null before the first refresh", () => {
    const service = new MigrationService(makeDeps());
    expect(service.getState()).toBeNull();
  });

  it("getVersionsDir() returns the injected project's versionsDir, even before any refresh (Task 18: codeLens.ts's DocumentSelector)", () => {
    const service = new MigrationService(makeDeps());
    expect(service.getVersionsDir()).toBe(DEFAULT_VERSIONS_DIR);
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

  it("getUiPrefs: legacy persisted prefs without axis field should default to horizontal", async () => {
    // Task H: legacy stored objects (before axis was added) lack the axis field.
    // getUiPrefs must merge with defaults so missing fields get their default values.
    const legacyStored = { order: "newest-bottom", density: "comfortable", expandCollapsed: false } as UiPrefs;
    const deps = makeDeps({
      getUiPrefs: vi.fn(() => ({ ...DEFAULT_UI, ...legacyStored })),
    });
    const service = new MigrationService(deps);

    await service.refresh();

    const state = service.getState();
    // Before the fix, state!.ui.axis would be undefined, causing silent fallback to vertical.
    // After the fix, it should be the default "horizontal".
    expect(state!.ui.axis).toBe("horizontal");
    expect(state!.ui.order).toBe("newest-bottom");
    expect(state!.ui.density).toBe("comfortable");
  });
});

/** A promise plus its out-of-band resolve/reject handles, for hand-sequencing async fetches. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the microtask queue drain so an un-awaited phase-2 enrichment .then() can run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

type FetchCurrentResult = { dbReachable: boolean; currentIds: string[] };

describe("MigrationService DB-state enrichment (fetchCurrent)", () => {
  // d4c7f5309b2e's ancestry in the fixture: c3d6e4b721a8 -> b2e5d3a10f66 -> 8f2a1c9d4e07 (root).
  const CURRENT_ID = "d4c7f5309b2e";
  const ANCESTOR_IDS = ["c3d6e4b721a8", "b2e5d3a10f66", "8f2a1c9d4e07"];

  it("7. a reachable fetchCurrent triggers a SECOND emit with dbReachable, applied, and isCurrent set", async () => {
    const fetch = deferred<FetchCurrentResult>();
    const fetchCurrent = vi.fn((): Promise<FetchCurrentResult> => fetch.promise);
    const deps = makeDeps({ fetchCurrent });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh();

    // Phase 1 emitted by refresh() itself: static state, DB unknown — NOT blocked on the CLI
    // (the fetch is still unresolved here and refresh() has already settled).
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].dbReachable).toBe(false);
    expect(listener.mock.calls[0][0].currentIds).toEqual([]);

    fetch.resolve({ dbReachable: true, currentIds: [CURRENT_ID] });
    await flushMicrotasks(); // let the un-awaited enrichment land

    expect(listener).toHaveBeenCalledTimes(2);
    const enriched = listener.mock.calls[1][0];
    expect(enriched.dbReachable).toBe(true);
    expect(enriched.currentIds).toEqual([CURRENT_ID]);

    const byId = new Map(enriched.layout.nodes.map((n: { id: string }) => [n.id, n]));
    expect(byId.get(CURRENT_ID)).toMatchObject({ applied: true, isCurrent: true });
    for (const id of ANCESTOR_IDS) {
      expect(byId.get(id)).toMatchObject({ applied: true, isCurrent: false });
    }
    // Everything outside the current node's ancestry is explicitly applied:false (not null).
    for (const node of enriched.layout.nodes) {
      if (node.kind !== "revision") continue;
      if (node.id === CURRENT_ID || ANCESTOR_IDS.includes(node.id)) continue;
      expect(node.applied).toBe(false);
      expect(node.isCurrent).toBe(false);
    }
    expect(service.getState()).toBe(enriched);
  });

  it("7b. getDetail reflects the enriched state automatically (applied + isCurrent)", async () => {
    const fetch = deferred<FetchCurrentResult>();
    const deps = makeDeps({ fetchCurrent: vi.fn((): Promise<FetchCurrentResult> => fetch.promise) });
    const service = new MigrationService(deps);
    await service.refresh();

    // Before enrichment lands: DB state unknown.
    expect(service.getDetail(CURRENT_ID)).toMatchObject({ applied: null, isCurrent: false });

    fetch.resolve({ dbReachable: true, currentIds: [CURRENT_ID] });
    await flushMicrotasks();

    expect(service.getDetail(CURRENT_ID)).toMatchObject({ applied: true, isCurrent: true });
    expect(service.getDetail(ANCESTOR_IDS[0])).toMatchObject({ applied: true, isCurrent: false });
    expect(service.getDetail("5c0d13aa7d9f")).toMatchObject({ applied: false, isCurrent: false });
  });

  it("8a. fetchCurrent resolving dbReachable:false -> exactly ONE emit total", async () => {
    const deps = makeDeps({
      fetchCurrent: vi.fn(async (): Promise<FetchCurrentResult> => ({ dbReachable: false, currentIds: [] })),
    });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh();
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(1); // phase 1 only; unreachable adds nothing new
    expect(service.getState()!.dbReachable).toBe(false);
    expect(service.getState()!.currentIds).toEqual([]);
  });

  it("8b. fetchCurrent rejecting -> exactly ONE emit total, error logged, nothing thrown", async () => {
    const deps = makeDeps({
      fetchCurrent: vi.fn(async (): Promise<FetchCurrentResult> => {
        throw new Error("adapter exploded unexpectedly");
      }),
    });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh();
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getState()!.dbReachable).toBe(false);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("adapter exploded unexpectedly"));
  });

  it("9. generation guard: a slow fetch from refresh#1 resolving after refresh#2 started is DISCARDED", async () => {
    const fetch1 = deferred<FetchCurrentResult>();
    const fetch2 = deferred<FetchCurrentResult>();
    const fetches = [fetch1.promise, fetch2.promise];
    const fetchCurrent = vi.fn((): Promise<FetchCurrentResult> => fetches.shift()!);

    const deps = makeDeps({ fetchCurrent });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh(); // scan #1; fetch #1 in flight
    await service.refresh(); // scan #2; fetch #2 in flight
    expect(fetchCurrent).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2); // two phase-1 emits

    // The STALE response from scan #1 arrives only now, after scan #2 has started -> discarded.
    fetch1.resolve({ dbReachable: true, currentIds: ["8f2a1c9d4e07"] });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(2); // no third emit with stale data
    expect(service.getState()!.dbReachable).toBe(false);
    expect(service.getState()!.currentIds).toEqual([]);

    // Scan #2's own response lands normally.
    fetch2.resolve({ dbReachable: true, currentIds: [CURRENT_ID] });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(service.getState()!.dbReachable).toBe(true);
    expect(service.getState()!.currentIds).toEqual([CURRENT_ID]);
  });

  it("9b. setExpandCollapsed after enrichment keeps applied/current state (no revert to unknown)", async () => {
    const deps = makeDeps({
      fetchCurrent: vi.fn(async (): Promise<FetchCurrentResult> => ({ dbReachable: true, currentIds: [CURRENT_ID] })),
    });
    const service = new MigrationService(deps);
    await service.refresh();
    await flushMicrotasks();
    expect(service.getState()!.dbReachable).toBe(true);

    await service.setExpandCollapsed(true); // re-lays out from the cached graph

    const node = service.getState()!.layout.nodes.find((n) => n.id === CURRENT_ID);
    expect(node).toMatchObject({ applied: true, isCurrent: true });
  });
});

type FetchAuthorsResult = Map<string, string>;

describe("MigrationService git-author enrichment (fetchAuthors)", () => {
  const ROOT_ID = "8f2a1c9d4e07";
  const ROOT_FILE_PATH = path.join(BROKEN_VERSIONS_DIR, "8f2a1c9d4e07_create_products_table.py");

  it("10. a resolved fetchAuthors triggers a SECOND emit with author patched onto the matching node only", async () => {
    const fetch = deferred<FetchAuthorsResult>();
    const fetchAuthors = vi.fn((): Promise<FetchAuthorsResult> => fetch.promise);
    const deps = makeDeps({ fetchAuthors });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh();

    // Phase 1: static state, author unknown — NOT blocked on the git batch (still unresolved here).
    expect(listener).toHaveBeenCalledTimes(1);
    const phase1Root = listener.mock.calls[0][0].layout.nodes.find((n: { id: string }) => n.id === ROOT_ID);
    expect(phase1Root.author).toBeNull();
    expect(fetchAuthors).toHaveBeenCalledWith(expect.arrayContaining([ROOT_FILE_PATH]));

    fetch.resolve(new Map([[ROOT_FILE_PATH, "Ada Lovelace"]]));
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(2);
    const enriched = listener.mock.calls[1][0];
    const enrichedRoot = enriched.layout.nodes.find((n: { id: string }) => n.id === ROOT_ID);
    expect(enrichedRoot.author).toBe("Ada Lovelace");

    // Every other revision node (no entry in the resolved map) stays null, not overwritten.
    const others = enriched.layout.nodes.filter((n: { id: string; kind: string }) => n.kind === "revision" && n.id !== ROOT_ID);
    expect(others.length).toBeGreaterThan(0);
    for (const n of others) expect(n.author).toBeNull();
    expect(service.getState()).toBe(enriched);
  });

  it("10b. getDetail reflects the enriched author automatically", async () => {
    const fetch = deferred<FetchAuthorsResult>();
    const deps = makeDeps({ fetchAuthors: vi.fn((): Promise<FetchAuthorsResult> => fetch.promise) });
    const service = new MigrationService(deps);
    await service.refresh();

    expect(service.getDetail(ROOT_ID)!.author).toBeNull();

    fetch.resolve(new Map([[ROOT_FILE_PATH, "Ada Lovelace"]]));
    await flushMicrotasks();

    expect(service.getDetail(ROOT_ID)!.author).toBe("Ada Lovelace");
  });

  it("11. fetchAuthors rejecting -> exactly ONE emit total, error logged, nothing thrown", async () => {
    const deps = makeDeps({
      fetchAuthors: vi.fn(async (): Promise<FetchAuthorsResult> => {
        throw new Error("git batch exploded unexpectedly");
      }),
    });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh();
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("git batch exploded unexpectedly"));
  });

  it("12. generation guard: a slow author batch from refresh#1 resolving after refresh#2 started is DISCARDED", async () => {
    const fetch1 = deferred<FetchAuthorsResult>();
    const fetch2 = deferred<FetchAuthorsResult>();
    const fetches = [fetch1.promise, fetch2.promise];
    const fetchAuthors = vi.fn((): Promise<FetchAuthorsResult> => fetches.shift()!);

    const deps = makeDeps({ fetchAuthors });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh(); // scan #1; author fetch #1 in flight
    await service.refresh(); // scan #2; author fetch #2 in flight
    expect(fetchAuthors).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2); // two phase-1 emits

    // The STALE response from scan #1 arrives only now, after scan #2 has started -> discarded.
    fetch1.resolve(new Map([[ROOT_FILE_PATH, "Stale Author"]]));
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(2); // no third emit with stale data
    expect(service.getDetail(ROOT_ID)!.author).toBeNull();

    // Scan #2's own response lands normally.
    fetch2.resolve(new Map([[ROOT_FILE_PATH, "Fresh Author"]]));
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(service.getDetail(ROOT_ID)!.author).toBe("Fresh Author");
  });

  it("13. an author batch resolved BEFORE a later dbReachable enrichment survives that enrichment's re-layout", async () => {
    const authorFetch = deferred<FetchAuthorsResult>();
    const currentFetch = deferred<{ dbReachable: boolean; currentIds: string[] }>();
    const deps = makeDeps({
      fetchAuthors: vi.fn((): Promise<FetchAuthorsResult> => authorFetch.promise),
      fetchCurrent: vi.fn(() => currentFetch.promise),
    });
    const service = new MigrationService(deps);
    await service.refresh();

    authorFetch.resolve(new Map([[ROOT_FILE_PATH, "Ada Lovelace"]]));
    await flushMicrotasks();
    expect(service.getState()!.layout.nodes.find((n) => n.id === ROOT_ID)!.author).toBe("Ada Lovelace");

    currentFetch.resolve({ dbReachable: true, currentIds: [ROOT_ID] });
    await flushMicrotasks();

    const node = service.getState()!.layout.nodes.find((n) => n.id === ROOT_ID)!;
    expect(node.applied).toBe(true); // the dbReachable enrichment's own re-layout landed...
    expect(node.author).toBe("Ada Lovelace"); // ...without wiping the author already known
  });

  it("13b. a dbReachable enrichment resolved BEFORE the author batch is preserved once authors land", async () => {
    const authorFetch = deferred<FetchAuthorsResult>();
    const currentFetch = deferred<{ dbReachable: boolean; currentIds: string[] }>();
    const deps = makeDeps({
      fetchAuthors: vi.fn((): Promise<FetchAuthorsResult> => authorFetch.promise),
      fetchCurrent: vi.fn(() => currentFetch.promise),
    });
    const service = new MigrationService(deps);
    await service.refresh();

    currentFetch.resolve({ dbReachable: true, currentIds: [ROOT_ID] });
    await flushMicrotasks();
    expect(service.getState()!.layout.nodes.find((n) => n.id === ROOT_ID)!.applied).toBe(true);

    authorFetch.resolve(new Map([[ROOT_FILE_PATH, "Ada Lovelace"]]));
    await flushMicrotasks();

    const node = service.getState()!.layout.nodes.find((n) => n.id === ROOT_ID)!;
    expect(node.author).toBe("Ada Lovelace");
    expect(node.applied).toBe(true); // still there — the author patch didn't touch it
  });

  it("14. setExpandCollapsed after author enrichment keeps the known author (no revert to null)", async () => {
    const deps = makeDeps({
      fetchAuthors: vi.fn(async (): Promise<FetchAuthorsResult> => new Map([[ROOT_FILE_PATH, "Ada Lovelace"]])),
    });
    const service = new MigrationService(deps);
    await service.refresh();
    await flushMicrotasks();
    expect(service.getState()!.layout.nodes.find((n) => n.id === ROOT_ID)!.author).toBe("Ada Lovelace");

    await service.setExpandCollapsed(true); // re-lays out from the cached graph

    const node = service.getState()!.layout.nodes.find((n) => n.id === ROOT_ID);
    expect(node!.author).toBe("Ada Lovelace");
  });
});

type FetchGhostBlameResult = Record<string, GhostBlame | null>;

describe("MigrationService ghost-blame enrichment (fetchGhostBlame, Task B1)", () => {
  const GHOST_ID = "deadbeef0000";
  const BROKEN_CHILD_FILE_PATH = path.join(BROKEN_VERSIONS_DIR, "5c0d13aa7d9f_add_audit_log.py");
  const SAMPLE_BLAME: GhostBlame = {
    kind: "deleted-here",
    commit: "abc123def456abc123def456abc123def456abc1",
    shortCommit: "abc123de",
    author: "Ada Lovelace",
    date: "2026-01-01T00:00:00Z",
    subject: "delete old revision",
    deletedFilePath: "versions/deadbeef0000_old.py",
  };

  it("a. a resolved fetchGhostBlame triggers a SECOND emit with ghostBlame populated; layout object reference unchanged", async () => {
    const fetch = deferred<FetchGhostBlameResult>();
    const fetchGhostBlame = vi.fn((): Promise<FetchGhostBlameResult> => fetch.promise);
    const deps = makeDeps({ fetchGhostBlame });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh();

    // Phase 1: static state, ghostBlame empty — NOT blocked on the git search (still unresolved).
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].ghostBlame).toEqual({});
    expect(fetchGhostBlame).toHaveBeenCalledWith([{ missingId: GHOST_ID, childFilePath: BROKEN_CHILD_FILE_PATH }]);
    const layoutBefore = listener.mock.calls[0][0].layout;

    fetch.resolve({ [GHOST_ID]: SAMPLE_BLAME });
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(2);
    const enriched = listener.mock.calls[1][0];
    expect(enriched.ghostBlame).toEqual({ [GHOST_ID]: SAMPLE_BLAME });
    expect(enriched.layout).toBe(layoutBefore); // no re-layout: ghostBlame isn't a layout concern
    expect(service.getState()).toBe(enriched);
  });

  it("b. generation guard: a slow ghost-blame batch from refresh#1 resolving after refresh#2 started is DISCARDED", async () => {
    const fetch1 = deferred<FetchGhostBlameResult>();
    const fetch2 = deferred<FetchGhostBlameResult>();
    const fetches = [fetch1.promise, fetch2.promise];
    const fetchGhostBlame = vi.fn((): Promise<FetchGhostBlameResult> => fetches.shift()!);

    const deps = makeDeps({ fetchGhostBlame });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh(); // scan #1; ghost-blame fetch #1 in flight
    await service.refresh(); // scan #2; ghost-blame fetch #2 in flight
    expect(fetchGhostBlame).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2); // two phase-1 emits

    // The STALE response from scan #1 arrives only now, after scan #2 has started -> discarded.
    fetch1.resolve({ [GHOST_ID]: SAMPLE_BLAME });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(2); // no third emit with stale data
    expect(service.getState()!.ghostBlame).toEqual({});

    // Scan #2's own response lands normally.
    fetch2.resolve({ [GHOST_ID]: SAMPLE_BLAME });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(service.getState()!.ghostBlame).toEqual({ [GHOST_ID]: SAMPLE_BLAME });
  });

  it("c. no ghosts in the graph -> fetchGhostBlame is never called", async () => {
    // Dropping the one file that revises the fixture's missing deadbeef0000 parent removes the
    // fixture's only ghost/broken link without introducing any new one.
    const filesWithoutBrokenChild = loadBrokenFiles().filter((f) => !f.path.endsWith("5c0d13aa7d9f_add_audit_log.py"));
    const fetchGhostBlame = vi.fn(async (): Promise<FetchGhostBlameResult> => ({}));
    const deps = makeDeps({ listVersionFiles: vi.fn(async () => filesWithoutBrokenChild), fetchGhostBlame });
    const service = new MigrationService(deps);

    await service.refresh();
    await flushMicrotasks();

    expect(service.getState()!.problems).toEqual([]);
    expect(fetchGhostBlame).not.toHaveBeenCalled();
    expect(service.getState()!.ghostBlame).toEqual({});
  });

  it("d. fetchGhostBlame rejecting -> exactly ONE emit total, error logged, nothing thrown", async () => {
    const deps = makeDeps({
      fetchGhostBlame: vi.fn(async (): Promise<FetchGhostBlameResult> => {
        throw new Error("git blame search exploded unexpectedly");
      }),
    });
    const service = new MigrationService(deps);
    const listener = vi.fn();
    service.onDidChangeState(listener);

    await service.refresh();
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("git blame search exploded unexpectedly"));
    expect(service.getState()!.ghostBlame).toEqual({});
  });

  it("e. a ghost-blame batch resolved BEFORE a later author enrichment survives that enrichment's re-emit", async () => {
    const ghostFetch = deferred<FetchGhostBlameResult>();
    const authorFetch = deferred<FetchAuthorsResult>();
    const deps = makeDeps({
      fetchGhostBlame: vi.fn((): Promise<FetchGhostBlameResult> => ghostFetch.promise),
      fetchAuthors: vi.fn((): Promise<FetchAuthorsResult> => authorFetch.promise),
    });
    const service = new MigrationService(deps);
    await service.refresh();

    ghostFetch.resolve({ [GHOST_ID]: SAMPLE_BLAME });
    await flushMicrotasks();
    expect(service.getState()!.ghostBlame).toEqual({ [GHOST_ID]: SAMPLE_BLAME });

    authorFetch.resolve(new Map());
    await flushMicrotasks();

    // The author enrichment's own re-emit must not wipe out the ghostBlame already landed.
    expect(service.getState()!.ghostBlame).toEqual({ [GHOST_ID]: SAMPLE_BLAME });
  });

  it("f. a repeat scan re-fires fetchGhostBlame but the previous batch's result is retained until the new one lands (no flicker)", async () => {
    const deps = makeDeps({
      fetchGhostBlame: vi.fn(async (): Promise<FetchGhostBlameResult> => ({ [GHOST_ID]: SAMPLE_BLAME })),
    });
    const service = new MigrationService(deps);
    await service.refresh();
    await flushMicrotasks();
    expect(service.getState()!.ghostBlame).toEqual({ [GHOST_ID]: SAMPLE_BLAME });

    await service.refresh(); // a second full scan (e.g. the file watcher firing again)
    // Phase-1 of the second scan emits synchronously before its own fetchGhostBlame resolves —
    // the already-known blame must still be visible, not reset to {} and flicker away.
    expect(service.getState()!.ghostBlame).toEqual({ [GHOST_ID]: SAMPLE_BLAME });

    await flushMicrotasks();
    expect(service.getState()!.ghostBlame).toEqual({ [GHOST_ID]: SAMPLE_BLAME });
  });
});

describe("laneColorsFor", () => {
  it("lane 0/1 use A/B verbatim; lanes >= 2 hue-rotate B by +40deg per lane", () => {
    expect(laneColorsFor(1, "#4aa3ff", "#c586c0")).toEqual(["#4aa3ff"]);
    expect(laneColorsFor(2, "#4aa3ff", "#c586c0")).toEqual(["#4aa3ff", "#c586c0"]);
    expect(laneColorsFor(4, "#4aa3ff", "#c586c0")).toEqual(["#4aa3ff", "#c586c0", "#c58696", "#c5a086"]);
  });

  it("laneCount 0 still yields a length-1 array (lane 0's color only)", () => {
    expect(laneColorsFor(0, "#4aa3ff", "#c586c0")).toEqual(["#4aa3ff"]);
  });

  it("invalid laneColorA falls back to the hardcoded default without disturbing laneColorB's lanes", () => {
    expect(laneColorsFor(2, "javascript:alert(1)", "#c586c0")).toEqual(["#4aa3ff", "#c586c0"]);
  });

  it("invalid laneColorB falls back to the hardcoded default for lane 1 AND every rotated lane", () => {
    expect(laneColorsFor(3, "#4aa3ff", "not-a-color")).toEqual(["#4aa3ff", "#c586c0", "#c58696"]);
  });

  it("both invalid -> both hardcoded defaults, never NaN/malformed", () => {
    const colors = laneColorsFor(3, "", "<script>");
    expect(colors).toEqual(["#4aa3ff", "#c586c0", "#c58696"]);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
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

/** Minimal synthetic versions/*.py content — just enough for parseRevisionSource to find
 * revision/down_revision/Revises: (see core/repoint.ts's test file for a more elaborate example);
 * used below to build small ad-hoc broken chains the checked-in fixtures don't have (a ghost with
 * >1 broken child, a cycle candidate several revisions deep). */
function pyFile(id: string, down: string | null, message: string): { path: string; content: string } {
  const downLine = down === null ? "down_revision = None" : `down_revision = '${down}'`;
  const content = `"""${message}

Revision ID: ${id}
Revises: ${down ?? ""}
Create Date: 2026-01-01 00:00:00.000000

"""
revision = '${id}'
${downLine}
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
`;
  return { path: `/tmp/${id}.py`, content };
}

describe("MigrationService.getRepointPlan", () => {
  it("no cached graph yet (before any refresh) -> error", () => {
    const service = new MigrationService(makeDeps());
    const plan = service.getRepointPlan("deadbeef0000", "3aebf1885b7d");
    expect(plan.ok).toBe(false);
  });

  it("happy path: the broken-project fixture's single broken child gets one edit", async () => {
    const deps = makeDeps();
    const service = new MigrationService(deps);
    await service.refresh();

    const plan = service.getRepointPlan("deadbeef0000", "3aebf1885b7d");
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.edits).toHaveLength(1);
      expect(plan.edits[0].revisionId).toBe("5c0d13aa7d9f");
      expect(plan.edits[0].filePath).toContain("5c0d13aa7d9f_add_audit_log.py");
    }
  });

  it("unknown ghost id -> error", async () => {
    const service = new MigrationService(makeDeps());
    await service.refresh();
    expect(service.getRepointPlan("not-a-real-ghost", "3aebf1885b7d").ok).toBe(false);
  });

  it("target id that isn't a real revision -> error", async () => {
    const service = new MigrationService(makeDeps());
    await service.refresh();
    expect(service.getRepointPlan("deadbeef0000", "not-a-real-revision").ok).toBe(false);
  });

  it("multi-child ghost: every broken child of the ghost gets its own edit", async () => {
    const files = [
      pyFile("a1111111111", null, "root"),
      pyFile("b2222222222", "ghost0000000", "broken child 1"),
      pyFile("c3333333333", "ghost0000000", "broken child 2"),
    ];
    const deps = makeDeps({ listVersionFiles: vi.fn(async () => files) });
    const service = new MigrationService(deps);
    await service.refresh();

    const plan = service.getRepointPlan("ghost0000000", "a1111111111");
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(new Set(plan.edits.map((e) => e.revisionId))).toEqual(new Set(["b2222222222", "c3333333333"]));
      expect(plan.edits).toHaveLength(2);
    }
  });

  it("cycle rejection: target is a descendant of the broken child, several hops down", async () => {
    // ghost -> b (broken) -> c -> d ; re-pointing ghost's link to d would make b (a child of the
    // ghost) an ancestor of d while d becomes b's new down_revision-of-down_revision — a cycle.
    const files = [
      pyFile("b2222222222", "ghost0000000", "b broken"),
      pyFile("c3333333333", "b2222222222", "c"),
      pyFile("d4444444444", "c3333333333", "d"),
    ];
    const deps = makeDeps({ listVersionFiles: vi.fn(async () => files) });
    const service = new MigrationService(deps);
    await service.refresh();

    const plan = service.getRepointPlan("ghost0000000", "d4444444444");
    expect(plan).toEqual({ ok: false, reason: "re-pointing would create a cycle" });
  });

  it("cycle rejection: target equals the broken child itself", async () => {
    const files = [pyFile("b2222222222", "ghost0000000", "b broken")];
    const deps = makeDeps({ listVersionFiles: vi.fn(async () => files) });
    const service = new MigrationService(deps);
    await service.refresh();

    const plan = service.getRepointPlan("ghost0000000", "b2222222222");
    expect(plan).toEqual({ ok: false, reason: "re-pointing would create a cycle" });
  });

  it("a sibling branch (not a descendant of any broken child) is a valid, non-cycle target", async () => {
    const files = [
      pyFile("a1111111111", null, "root"),
      pyFile("b2222222222", "ghost0000000", "broken child"),
      pyFile("sibling00001", "a1111111111", "unrelated sibling branch"),
    ];
    const deps = makeDeps({ listVersionFiles: vi.fn(async () => files) });
    const service = new MigrationService(deps);
    await service.refresh();

    const plan = service.getRepointPlan("ghost0000000", "sibling00001");
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.edits.map((e) => e.revisionId)).toEqual(["b2222222222"]);
  });
});
