/**
 * Host-side conductor: scan versions dir -> parse -> graph -> layout -> AppState -> emit.
 *
 * Architecture rule: this file must NOT import `vscode`. All host dependencies (file access,
 * configuration, persisted UI prefs, logging) are injected via `MigrationServiceDeps` so this
 * class is fully vitest-testable in isolation. Only discovery.ts and extension.ts touch vscode.
 *
 * Task 13 will extend `refresh()` to enrich the layout with alembic-CLI `current`/`applied`
 * state (currently hardcoded to `dbReachable: false`, `currentIds: []`, `appliedSet: null`) —
 * that seam is the `appliedSet`/`currentIds` fields passed into `layoutGraph` below.
 */
import { buildGraph } from "../core/graph";
import { layoutGraph } from "../core/layout";
import { parseRevisionSource } from "../core/parser";
import type { MigrationGraph } from "../core/types";
import type { AppState, UiPrefs } from "../protocol/messages";

export interface MigrationServiceDeps {
  /** List and read all *.py files in the versions dir. */
  listVersionFiles(): Promise<{ path: string; content: string }[]>;
  getConfig(): { laneColorA: string; laneColorB: string; showSqlPreview: boolean; collapseThreshold: number };
  getUiPrefs(): UiPrefs;
  setUiPrefs(prefs: UiPrefs): void;
  log(line: string): void;
  project: { label: string; iniPath: string };
}

const DEBOUNCE_MS = 300;

export class MigrationService {
  private readonly deps: MigrationServiceDeps;
  private state: AppState | null = null;
  /** Parsed graph from the last successful refresh — reused by setExpandCollapsed so it never
   * needs to re-read files just to change the collapse/expand display option. */
  private cachedGraph: MigrationGraph | null = null;
  private readonly listeners = new Set<(s: AppState) => void>();

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Non-null while a refresh cycle (initial call + any coalesced trailing refresh) is running.
   * Every refresh() call made while this is set piggybacks on it instead of starting a second
   * concurrent read. */
  private cyclePromise: Promise<void> | null = null;
  /** Set by a refresh() call that arrives while a cycle is in flight; consumed by the cycle loop
   * to run exactly one trailing refresh once the current one finishes. */
  private queued = false;

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

      const layout = layoutGraph(graph, {
        collapseThreshold: config.collapseThreshold,
        expandCollapsed: ui.expandCollapsed,
        appliedSet: null, // DB current/applied enrichment arrives in Task 13
        currentIds: [],
      });

      const state: AppState = {
        project: { label: this.deps.project.label, iniPath: this.deps.project.iniPath },
        layout,
        heads: graph.heads.map((id) => ({ id, message: graph.nodes[id].message })),
        currentIds: [],
        problems: graph.problems,
        dbReachable: false,
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
      this.state = state;

      this.deps.log(
        `scan: ${files.length} files, ${state.counts.revisions} revisions, ${state.counts.heads} heads, ${state.counts.problems} problems`,
      );
      this.deps.log(JSON.stringify(state));

      this.emit(state);
    } catch (err) {
      // Defensive: parser/graph/layout are pure and don't throw on any known-broken input, but
      // don't let an unexpected exception here leave the previous state's consumers unaware.
      this.deps.log(`error building migration graph: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    const layout = layoutGraph(this.cachedGraph, {
      collapseThreshold: config.collapseThreshold,
      expandCollapsed: v,
      appliedSet: null,
      currentIds: [],
    });

    this.state = {
      ...this.state,
      layout,
      laneColors: laneColorsFor(layout.laneCount, config.laneColorA, config.laneColorB),
      ui,
    };
    this.emit(this.state);
  }

  /** Null before the first refresh. */
  getState(): AppState | null {
    return this.state;
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
