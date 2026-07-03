/**
 * Host-side conductor: scan versions dir -> parse -> graph -> layout -> AppState -> emit.
 *
 * Architecture rule: this file must NOT import `vscode`. All host dependencies (file access,
 * configuration, persisted UI prefs, logging) are injected via `MigrationServiceDeps` so this
 * class is fully vitest-testable in isolation. Only discovery.ts and extension.ts touch vscode.
 *
 * DB current/applied state (Task 13): `refresh()` is two-phase. Phase 1 (synchronous, everything
 * above) always emits the static scan with `dbReachable: false, appliedSet: null` — the CLI must
 * never block or fail this. Phase 2, only if `deps.fetchCurrent` is provided, fires the CLI async
 * (not awaited by refresh()'s own promise) and, if it resolves reachable before a newer scan has
 * started, re-lays out and emits a second time with real applied/current state. See `enrichment`
 * + `applyEnrichment` + `layoutOptsFor` below.
 */
import { buildGraph, computeAppliedSet } from "../core/graph";
import { layoutGraph, type LayoutOptions } from "../core/layout";
import { extractFunctionBody, parseRevisionSource } from "../core/parser";
import type { MigrationGraph } from "../core/types";
import type { AppState, RevisionDetail, UiPrefs } from "../protocol/messages";

export interface MigrationServiceDeps {
  /** List and read all *.py files in the versions dir. */
  listVersionFiles(): Promise<{ path: string; content: string }[]>;
  getConfig(): { laneColorA: string; laneColorB: string; showSqlPreview: boolean; collapseThreshold: number };
  getUiPrefs(): UiPrefs;
  setUiPrefs(prefs: UiPrefs): void;
  log(line: string): void;
  project: { label: string; iniPath: string };
  /**
   * Optional adapter over AlembicCli.current(). Absent in tests/deps that don't care about DB
   * state (state stays `dbReachable: false` forever, exactly as before Task 13). Never expected
   * to throw (AlembicCli.current() never does) but refresh() guards against a rejection anyway.
   */
  fetchCurrent?(): Promise<{ dbReachable: boolean; currentIds: string[] }>;
}

const DEBOUNCE_MS = 300;

export class MigrationService {
  private readonly deps: MigrationServiceDeps;
  private state: AppState | null = null;
  /** Parsed graph from the last successful refresh — reused by setExpandCollapsed so it never
   * needs to re-read files just to change the collapse/expand display option. */
  private cachedGraph: MigrationGraph | null = null;
  /** Raw source text per file path, refreshed in lockstep with `cachedGraph` — the detail panel's
   * upgrade()/downgrade() bodies (getDetail) are extracted from this without re-reading disk. */
  private rawContent: Map<string, string> = new Map();
  private readonly listeners = new Set<(s: AppState) => void>();

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Non-null while a refresh cycle (initial call + any coalesced trailing refresh) is running.
   * Every refresh() call made while this is set piggybacks on it instead of starting a second
   * concurrent read. */
  private cyclePromise: Promise<void> | null = null;
  /** Set by a refresh() call that arrives while a cycle is in flight; consumed by the cycle loop
   * to run exactly one trailing refresh once the current one finishes. */
  private queued = false;

  /** Bumped once per doRefresh() call (i.e. per scan, including trailing ones). A phase-2
   * fetchCurrent() response tags itself with the value at the time it was fired; if the counter
   * has moved on by the time it resolves, a newer scan has started and the response is stale —
   * see applyEnrichment. */
  private scanGeneration = 0;
  /** Last DB state phase 2 actually confirmed (vs. `state.dbReachable`, which phase 1 always
   * resets to false at the start of every scan). Re-layout call sites that don't re-scan
   * (setExpandCollapsed, applyUiPrefs) read this via layoutOptsFor so toggling a display option
   * after a successful enrichment doesn't revert applied dots to "unknown". */
  private enrichment: { dbReachable: boolean; currentIds: string[] } = { dbReachable: false, currentIds: [] };

  constructor(deps: MigrationServiceDeps) {
    this.deps = deps;
  }

  /** Full re-read + rebuild + emit. Concurrent calls coalesce: at most one trailing refresh runs
   * after the in-flight one finishes, and every caller's promise resolves once the whole cycle
   * (including that trailing refresh, if any) is done. */
  refresh(): Promise<void> {
    if (this.cyclePromise) {
      this.queued = true;
      return this.cyclePromise;
    }
    this.cyclePromise = this.runCycle();
    return this.cyclePromise;
  }

  private async runCycle(): Promise<void> {
    try {
      do {
        this.queued = false;
        await this.doRefresh();
      } while (this.queued);
    } finally {
      // Guaranteed even if doRefresh somehow throws, so a pathological error can't wedge every
      // future refresh() call into piggybacking on a promise that already settled.
      this.cyclePromise = null;
    }
  }

  private async doRefresh(): Promise<void> {
    // A newer scan has started as of this line, full stop — see applyEnrichment's generation
    // check. Bumped unconditionally (even if listVersionFiles below fails) so a slow phase-2
    // response from an older, still-successful scan can never resurrect stale currentIds/
    // appliedSet onto whatever state a later doRefresh() call leaves in place.
    this.scanGeneration += 1;
    const myGeneration = this.scanGeneration;

    let files: { path: string; content: string }[];
    try {
      files = await this.deps.listVersionFiles();
    } catch (err) {
      this.deps.log(`error scanning versions directory: ${err instanceof Error ? err.message : String(err)}`);
      return; // keep previous state, no emit
    }

    try {
      const revisions = [];
      for (const file of files) {
        const parsed = parseRevisionSource(file.content, file.path);
        if (parsed !== null) revisions.push(parsed);
      }

      const graph = buildGraph(revisions);
      const config = this.deps.getConfig();
      const ui = this.deps.getUiPrefs();

      // Phase 1: every scan starts from "DB state unknown", regardless of what a previous scan's
      // enrichment last confirmed — a stale "current" badge surviving into a freshly-scanned
      // graph (whose nodes may no longer match) would be worse than a momentary "unknown".
      this.enrichment = { dbReachable: false, currentIds: [] };

      const layout = layoutGraph(graph, this.layoutOptsFor(graph, config, ui.expandCollapsed));

      const state: AppState = {
        project: { label: this.deps.project.label, iniPath: this.deps.project.iniPath },
        layout,
        heads: graph.heads.map((id) => ({ id, message: graph.nodes[id].message })),
        currentIds: this.enrichment.currentIds,
        problems: graph.problems,
        dbReachable: this.enrichment.dbReachable,
        laneColors: laneColorsFor(layout.laneCount, config.laneColorA, config.laneColorB),
        counts: {
          revisions: Object.keys(graph.nodes).length,
          heads: graph.heads.length,
          problems: graph.problems.length,
        },
        config: { showSqlPreview: config.showSqlPreview },
        ui,
      };

      this.cachedGraph = graph;
      this.rawContent = new Map(files.map((file) => [file.path, file.content]));
      this.state = state;

      this.deps.log(
        `scan: ${files.length} files, ${state.counts.revisions} revisions, ${state.counts.heads} heads, ${state.counts.problems} problems`,
      );
      this.deps.log(JSON.stringify(state));

      this.emit(state);

      // Phase 2: async DB-state enrichment, deliberately NOT awaited here — refresh() must
      // resolve as soon as phase 1 is emitted, never blocked on an external `alembic` process
      // (the golden rule: CLI failures degrade silently and never hold up the graph). Tagged with
      // this scan's generation so a response landing after a newer scan has started is discarded.
      if (this.deps.fetchCurrent) {
        this.deps
          .fetchCurrent()
          .then((result) => this.applyEnrichment(myGeneration, graph, result))
          .catch((err) => {
            // fetchCurrent's adapter (AlembicCli.current()) never rejects in practice, but a
            // custom test/deps implementation might — degrade the same as any other CLI failure:
            // log it, keep the phase-1 dbReachable:false already emitted, no throw.
            this.deps.log(`error fetching current revision: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
    } catch (err) {
      // Defensive: parser/graph/layout are pure and don't throw on any known-broken input, but
      // don't let an unexpected exception here leave the previous state's consumers unaware.
      this.deps.log(`error building migration graph: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Applies a resolved fetchCurrent() result to the graph that was current when it was fired.
   * Discards silently (no emit) if: a newer scan has started (`generation` stale), the DB wasn't
   * reachable (state already says so from phase 1 — nothing new to show), or there's no state to
   * enrich (shouldn't happen: phase 1 always sets one before phase 2 is fired).
   */
  private applyEnrichment(
    generation: number,
    graph: MigrationGraph,
    result: { dbReachable: boolean; currentIds: string[] },
  ): void {
    if (generation !== this.scanGeneration) return; // stale: a newer scan has since started
    if (!result.dbReachable || this.state === null) return; // nothing new to emit

    this.enrichment = { dbReachable: true, currentIds: result.currentIds };

    const config = this.deps.getConfig();
    const layout = layoutGraph(graph, this.layoutOptsFor(graph, config, this.state.ui.expandCollapsed));

    this.state = {
      ...this.state,
      layout,
      currentIds: result.currentIds,
      dbReachable: true,
      laneColors: laneColorsFor(layout.laneCount, config.laneColorA, config.laneColorB),
    };
    this.emit(this.state);
  }

  /** LayoutOptions for `graph`, folding in the last confirmed DB enrichment (if any) alongside
   * the given collapse/expand settings. Shared by doRefresh, applyEnrichment, setExpandCollapsed,
   * and applyUiPrefs so every re-layout call site — not just a full re-scan — reflects the latest
   * known applied/current state instead of silently reverting it to "unknown". */
  private layoutOptsFor(
    graph: MigrationGraph,
    config: { collapseThreshold: number },
    expandCollapsed: boolean,
  ): LayoutOptions {
    return {
      collapseThreshold: config.collapseThreshold,
      expandCollapsed,
      appliedSet: this.enrichment.dbReachable ? computeAppliedSet(graph, this.enrichment.currentIds) : null,
      currentIds: this.enrichment.currentIds,
    };
  }

  /** Debounced refresh — repeated calls within the window coalesce into ONE refresh. */
  scheduleRefresh(delayMs = DEBOUNCE_MS): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, delayMs);
  }

  /** Updates prefs + re-emits state. Client-side flip only: no re-read, no re-layout. */
  setOrder(order: UiPrefs["order"]): void {
    this.updateUi({ order });
  }

  /** Updates prefs + re-emits state. Client-side flip only: no re-read, no re-layout. */
  setDensity(d: UiPrefs["density"]): void {
    this.updateUi({ density: d });
  }

  private updateUi(patch: Partial<UiPrefs>): void {
    const base = this.state?.ui ?? this.deps.getUiPrefs();
    const ui: UiPrefs = { ...base, ...patch };
    this.deps.setUiPrefs(ui);
    if (this.state === null) return;
    this.state = { ...this.state, ui };
    this.emit(this.state);
  }

  /** Re-lays out from the cached graph (no file re-read) + emits. */
  async setExpandCollapsed(v: boolean): Promise<void> {
    const base = this.state?.ui ?? this.deps.getUiPrefs();
    const ui: UiPrefs = { ...base, expandCollapsed: v };
    this.deps.setUiPrefs(ui);

    if (this.state === null || this.cachedGraph === null) return;

    const config = this.deps.getConfig();
    const layout = layoutGraph(this.cachedGraph, this.layoutOptsFor(this.cachedGraph, config, v));

    this.state = {
      ...this.state,
      layout,
      laneColors: laneColorsFor(layout.laneCount, config.laneColorA, config.laneColorB),
      ui,
    };
    this.emit(this.state);
  }

  /**
   * Adopts a batch of restored UI prefs (Task 11's `ready.restored` convergence: the webview's
   * persisted copy wins over whatever the host had stored) in one shot: persists the merged
   * result via `setUiPrefs`, re-layouts from the cached graph only if `expandCollapsed` actually
   * changed (order/density are render-only, no re-layout needed), and emits AT MOST ONE state —
   * zero emits (and no `setUiPrefs` call) if the merged prefs are identical to the current ones.
   */
  async applyUiPrefs(prefs: Partial<UiPrefs>): Promise<void> {
    const base = this.state?.ui ?? this.deps.getUiPrefs();
    const ui: UiPrefs = { ...base, ...prefs };

    const expandChanged = ui.expandCollapsed !== base.expandCollapsed;
    const changed = expandChanged || ui.order !== base.order || ui.density !== base.density;
    if (!changed) return; // true no-op: nothing differs, don't even touch persisted storage

    this.deps.setUiPrefs(ui);
    if (this.state === null) return;

    if (expandChanged && this.cachedGraph !== null) {
      const config = this.deps.getConfig();
      const layout = layoutGraph(this.cachedGraph, this.layoutOptsFor(this.cachedGraph, config, ui.expandCollapsed));
      this.state = {
        ...this.state,
        layout,
        laneColors: laneColorsFor(layout.laneCount, config.laneColorA, config.laneColorB),
        ui,
      };
    } else {
      this.state = { ...this.state, ui };
    }
    this.emit(this.state);
  }

  /** Null before the first refresh. */
  getState(): AppState | null {
    return this.state;
  }

  /**
   * Sync, pure-over-caches assembly of the revision detail panel payload. Returns null when
   * there's no cached graph yet, or `id` isn't a real revision (unknown id, or a ghost/collapse
   * placeholder id — neither has a graph node). GraphPanelManager forwards a null straight
   * through as `{type:"detail", forId:id, detail:null}` so the webview knows to hide the panel.
   */
  getDetail(id: string): RevisionDetail | null {
    const graph = this.cachedGraph;
    const state = this.state;
    if (graph === null || state === null) return null;

    const node = graph.nodes[id];
    if (!node) return null;

    const layoutNode = state.layout.nodes.find((n) => n.id === id);
    const applied = layoutNode?.applied ?? null;

    // Re-read live (not the config captured at last refresh): the panel must reflect a setting
    // flipped after the graph was last scanned, without forcing a full refresh.
    const config = this.deps.getConfig();
    let upgradeBody: string | null = null;
    let downgradeBody: string | null = null;
    if (config.showSqlPreview) {
      const content = this.rawContent.get(node.filePath);
      if (content !== undefined) {
        upgradeBody = extractFunctionBody(content, "upgrade");
        downgradeBody = extractFunctionBody(content, "downgrade");
      }
    }

    return {
      id,
      hash: id,
      message: node.message,
      author: null, // git-blame enrichment arrives in Task 21
      date: node.createDate,
      applied,
      isCurrent: state.currentIds.includes(id),
      isHead: node.isHead,
      isMerge: node.isMerge,
      isBroken: node.isBroken,
      branchLabel: node.branchLabels[0] ?? null,
      downRevisions: node.downRevisions.map((parentId) => ({ id: parentId, missing: !(parentId in graph.nodes) })),
      filePath: node.filePath,
      upgradeBody,
      downgradeBody,
    };
  }

  onDidChangeState(listener: (s: AppState) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(state: AppState): void {
    for (const listener of this.listeners) listener(state);
  }

  /** Cancels any pending debounce. */
  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.listeners.clear();
  }
}

/** array of length max(laneCount, 1): index 0 = laneColorA, all others laneColorB. */
function laneColorsFor(laneCount: number, laneColorA: string, laneColorB: string): string[] {
  const length = Math.max(laneCount, 1);
  return Array.from({ length }, (_, i) => (i === 0 ? laneColorA : laneColorB));
}
