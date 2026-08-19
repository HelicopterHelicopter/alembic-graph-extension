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
import { DEFAULT_LANE_COLOR_A, DEFAULT_LANE_COLOR_B, isValidHex, rotateHue } from "../core/color";
import { layoutGraph, type LayoutOptions } from "../core/layout";
import { extractFunctionBody, parseRevisionSource } from "../core/parser";
import type { GraphLayout, MigrationGraph, RevisionNode } from "../core/types";
import type {
  AppState,
  GhostBlame,
  RevisionDetail,
  TopologyFileEdit,
  TopologyOp,
  TopologyPlan,
  UiPrefs,
} from "../protocol/messages";

export type RepointPlan =
  | { ok: true; edits: { revisionId: string; filePath: string }[] }
  | { ok: false; reason: string };

export interface MigrationServiceDeps {
  /** List and read all *.py files in the versions dir. */
  listVersionFiles(): Promise<{ path: string; content: string }[]>;
  getConfig(): { laneColorA: string; laneColorB: string; showSqlPreview: boolean; collapseThreshold: number };
  getUiPrefs(): UiPrefs;
  setUiPrefs(prefs: UiPrefs): void;
  log(line: string): void;
  project: { label: string; iniPath: string; versionsDir: string };
  /**
   * Optional adapter over AlembicCli.current(). Absent in tests/deps that don't care about DB
   * state (state stays `dbReachable: false` forever, exactly as before Task 13). Never expected
   * to throw (AlembicCli.current() never does) but refresh() guards against a rejection anyway.
   */
  fetchCurrent?(): Promise<{ dbReachable: boolean; currentIds: string[] }>;
  /**
   * Optional adapter over a git author provider (Task 21's gitAuthor.ts `AuthorProvider.lookup`).
   * Absent in tests/deps that don't care about authors (nodes/detail stay `author: null` forever).
   * Never expected to throw (the provider's own golden rule) but refresh() guards against a
   * rejection anyway, same treatment as `fetchCurrent`.
   */
  fetchAuthors?(filePaths: string[]): Promise<Map<string, string>>;
  /**
   * Optional adapter over a git ghost-blame provider (Task B1's gitDeletion.ts
   * `GhostBlameProvider.lookup`). Absent in tests/deps that don't care about it (`state.ghostBlame`
   * stays `{}` forever). Never expected to throw (the provider's own golden rule) but refresh()
   * guards against a rejection anyway, same treatment as `fetchCurrent`/`fetchAuthors`.
   */
  fetchGhostBlame?(requests: { missingId: string; childFilePath: string }[]): Promise<Record<string, GhostBlame | null>>;
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

  /** Last confirmed git-author batch (Task 21), keyed by revision file path — populated by
   * `applyAuthors` once `deps.fetchAuthors` resolves, and re-applied onto every subsequent
   * re-layout (`buildLayout`) so a later DB-state enrichment or a display-option toggle never wipes
   * out authors already known. Persists across scans on purpose (a repeat lookup for the same path
   * is free — see gitAuthor.ts's own cache); a file that disappears from the graph simply stops
   * matching any node, harmlessly. */
  private authorsByPath: Map<string, string> = new Map();

  /** Last confirmed git ghost-blame batch (Task B1), keyed by missing revision id — populated by
   * `applyGhostBlame` once `deps.fetchGhostBlame` resolves, and merged (not replaced) on every
   * subsequent resolve so a later scan's re-fire never wipes out a ghost id it didn't happen to
   * re-resolve. Persists across scans on purpose, same rationale as `authorsByPath`: a repeat
   * lookup for an already-known id is free (see gitDeletion.ts's own per-id cache), and a ghost
   * that disappears from the graph (repointed/restored) simply stops matching any UI ghost card,
   * harmlessly. Not layout data — unlike authors, this never triggers a re-layout; it's a plain
   * top-level `AppState.ghostBlame` field the webview reads alongside the layout. */
  private ghostBlameById: Record<string, GhostBlame | null> = {};

  /** Set once by `dispose()`. Task 21 made `dispose()` reachable mid-session (a project switch
   * disposes the previous project's service while it may still be mid-`refresh()`), whereas
   * before it only ever ran at full extension deactivation — where nobody cared if an in-flight
   * scan kept running to completion. Now that a disposed service's owning pipeline may already be
   * gone (its Output channel lines misattributed to whatever project replaced it, its CLI/git
   * calls wasted work for a project nobody's looking at anymore), `doRefresh()` checks this after
   * its one real await point and bails before building/emitting/logging anything further. */
  private disposed = false;

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

    // Task 21: this service may have been disposed (a project switch) while the read above was in
    // flight — never build/emit/log against a torn-down service, and never fire the CLI/git
    // enrichment calls below for a project nobody's looking at anymore.
    if (this.disposed) return;

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

      const layout = this.buildLayout(graph, config, ui.expandCollapsed);

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
        ghostBlame: this.ghostBlameById,
      };

      this.cachedGraph = graph;
      this.rawContent = new Map(files.map((file) => [file.path, file.content]));
      this.state = state;

      this.deps.log(
        `scan: ${files.length} files, ${state.counts.revisions} revisions, ${state.counts.heads} heads, ${state.counts.problems} problems`,
      );

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

      // Phase 2b: async git-author enrichment, same NOT-awaited/generation-guarded treatment as
      // phase 2 above — a slow `git log` batch must never block refresh(), and a response landing
      // after a newer scan has started is discarded. Independent of fetchCurrent: both can be in
      // flight at once, and each applies its own patch to whatever `this.state` is live when it
      // resolves (see applyAuthors + buildLayout's reapplication of `authorsByPath`), so the two
      // never tear each other's half of the state.
      if (this.deps.fetchAuthors) {
        const filePaths = files.map((file) => file.path);
        this.deps
          .fetchAuthors(filePaths)
          .then((result) => this.applyAuthors(myGeneration, result))
          .catch((err) => {
            // The gitAuthor provider's own golden rule means this never actually rejects, but
            // degrade the same as any other best-effort enrichment if a custom deps impl does.
            this.deps.log(`error fetching git authors: ${err instanceof Error ? err.message : String(err)}`);
          });
      }

      // Phase 2c: async ghost-blame enrichment (Task B1), same NOT-awaited/generation-guarded
      // treatment as phases 2/2b above — the (multi-git-call) blame search must never block
      // refresh(), and a response landing after a newer scan has started is discarded. Only fired
      // when there's actually a ghost to blame: an empty `graph.ghosts` means nothing to look up
      // and no reason to invoke the provider at all (mirrors fetchCurrent/fetchAuthors always
      // firing unconditionally, but this one has a real "nothing to do" case they don't).
      if (this.deps.fetchGhostBlame && graph.ghosts.length > 0) {
        const requests = graph.ghosts.map((g) => ({ missingId: g.id, childFilePath: graph.nodes[g.childIds[0]].filePath }));
        this.deps
          .fetchGhostBlame(requests)
          .then((result) => this.applyGhostBlame(myGeneration, result))
          .catch((err) => {
            // The gitDeletion provider's own golden rule means this never actually rejects, but
            // degrade the same as any other best-effort enrichment if a custom deps impl does.
            this.deps.log(`error fetching ghost blame: ${err instanceof Error ? err.message : String(err)}`);
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

    // Keep only ids that name a graph node. parseCurrentOutput (alembicCli.ts) is deliberately
    // permissive about token shape — custom `--rev-id` values are arbitrary — so a single-token
    // stdout line printed by the project's own env.py ("Done", a schema name, ...) is
    // indistinguishable from a bare revision id at parse time. This membership check is what keeps
    // such junk out of every display path (status bar, sidebar, isCurrent badges); the dropped
    // tokens are logged so the rarer legitimate case (the DB's current revision missing from the
    // local files) stays diagnosable instead of silently reading as "unknown".
    const currentIds = result.currentIds.filter((id) => Object.hasOwn(graph.nodes, id));
    const dropped = result.currentIds.filter((id) => !Object.hasOwn(graph.nodes, id));
    if (dropped.length > 0) {
      this.deps.log(`current revision ids not in the local graph (ignored): ${dropped.join(", ")}`);
    }

    this.enrichment = { dbReachable: true, currentIds };

    const config = this.deps.getConfig();
    const layout = this.buildLayout(graph, config, this.state.ui.expandCollapsed);

    this.state = {
      ...this.state,
      layout,
      currentIds,
      dbReachable: true,
      laneColors: laneColorsFor(layout.laneCount, config.laneColorA, config.laneColorB),
    };
    this.emit(this.state);
  }

  /**
   * Applies a resolved fetchAuthors() batch (Task 21) to whatever state is CURRENTLY live —
   * deliberately not the graph/layout captured when the fetch was fired, since a dbReachable
   * enrichment may have already re-laid things out in the meantime (see `buildLayout`, which is
   * what keeps that re-layout from wiping these authors right back out again). Discards silently
   * if a newer scan has started, or there's no state yet to patch.
   */
  private applyAuthors(generation: number, result: Map<string, string>): void {
    if (generation !== this.scanGeneration) return; // stale: a newer scan has since started
    if (this.state === null) return; // nothing to patch onto

    this.authorsByPath = result;
    const nodes = this.applyAuthorsToNodes(this.state.layout.nodes);
    this.state = { ...this.state, layout: { ...this.state.layout, nodes } };
    this.emit(this.state);
  }

  /**
   * Applies a resolved fetchGhostBlame() batch (Task B1) to whatever state is CURRENTLY live —
   * merged into (not replacing) `ghostBlameById` so a scan that only re-resolves SOME ids (e.g. a
   * newly-cached hit) never wipes out ids a previous batch already found. Discards silently if a
   * newer scan has started, or there's no state yet to patch. Unlike `applyAuthors`, this never
   * re-lays out anything — `ghostBlame` is a plain top-level `AppState` field, not layout data.
   */
  private applyGhostBlame(generation: number, result: Record<string, GhostBlame | null>): void {
    if (generation !== this.scanGeneration) return; // stale: a newer scan has since started
    if (this.state === null) return; // nothing to patch onto

    this.ghostBlameById = { ...this.ghostBlameById, ...result };
    this.state = { ...this.state, ghostBlame: this.ghostBlameById };
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

  /** `layoutGraph` + the last confirmed author batch (if any) re-applied on top — every re-layout
   * call site (doRefresh, applyEnrichment, setExpandCollapsed, applyUiPrefs) goes through this
   * instead of `layoutGraph` directly, so none of them can silently revert an already-known author
   * back to null just because THEY didn't just re-run the author fetch themselves. */
  private buildLayout(
    graph: MigrationGraph,
    config: { collapseThreshold: number },
    expandCollapsed: boolean,
  ): GraphLayout {
    const layout = layoutGraph(graph, this.layoutOptsFor(graph, config, expandCollapsed));
    return { ...layout, nodes: this.applyAuthorsToNodes(layout.nodes) };
  }

  /** Patches `author` onto every node whose `filePath` has a known entry in `authorsByPath` — a
   * no-op (same array reference) when nothing is known yet, so a pre-enrichment re-layout doesn't
   * even allocate a new node array for nothing. Ghost/collapse nodes (`filePath: null`) never
   * match, same as they never had an author to begin with. */
  private applyAuthorsToNodes(nodes: GraphLayout["nodes"]): GraphLayout["nodes"] {
    if (this.authorsByPath.size === 0) return nodes;
    return nodes.map((n) => {
      if (n.filePath === null) return n;
      const author = this.authorsByPath.get(n.filePath);
      return author !== undefined ? { ...n, author } : n;
    });
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

  /** Updates prefs + re-emits state. Client-side flip only (Task H): the layout engine's
   * lane/row output is untouched — axis is purely a webview pixel-mapping concern, same as
   * order/density. */
  setAxis(axis: UiPrefs["axis"]): void {
    this.updateUi({ axis });
  }

  /** Updates prefs + re-emits state. Client-side flip only (edit-mode lock): the lock is enforced
   * entirely in the webview's gesture layer (dnd.ts's pointerdown, contextMenu.ts's edge branch),
   * so nothing host-side — layout, planning, or the `topologyEdit`/`merge`/`repoint` handlers —
   * changes behavior with this. It exists here purely so the flag rides the same
   * workspaceState-persisted UiPrefs rail as order/density/axis. */
  setEditLocked(editLocked: boolean): void {
    this.updateUi({ editLocked });
  }

  private updateUi(patch: Partial<UiPrefs>): void {
    const base = this.state?.ui ?? this.deps.getUiPrefs();
    const ui: UiPrefs = { ...base, ...patch };
    this.deps.setUiPrefs(ui);
    if (this.state === null) return;
    this.state = { ...this.state, ui };
    this.emit(this.state);
  }

  /**
   * Task 21's config live-reload path: re-derives `laneColors`, `config.showSqlPreview`, and the
   * collapse layout from the CACHED graph and a fresh `deps.getConfig()` read — no file re-read, no
   * DB (`fetchCurrent`)/git (`fetchAuthors`) enrichment re-fired, and (via `buildLayout` folding in
   * `this.enrichment`/`this.authorsByPath` same as every other re-layout call site) no reset of
   * already-known applied/current/author state. A no-op before the first successful `refresh()`
   * (nothing cached yet to re-derive from).
   *
   * This exists because `laneColorA`/`laneColorB`/`showSqlPreview`/`collapseThreshold` changing is
   * the ONLY thing extension.ts's `onDidChangeConfiguration` handler needs to react to, and the
   * obvious-looking alternative — just calling `refresh()` — is deceptively expensive: it re-reads
   * every `versions/*.py` file, resets DB/author enrichment to "unknown" for a moment (a visible
   * flicker of every applied/current badge and every author disappearing and reappearing), and
   * re-fires a real `alembic` subprocess and a full git-log batch, all for a change that has
   * nothing to do with file contents.
   */
  applyConfigChange(): void {
    if (this.state === null || this.cachedGraph === null) return;

    const config = this.deps.getConfig();
    const layout = this.buildLayout(this.cachedGraph, config, this.state.ui.expandCollapsed);

    this.state = {
      ...this.state,
      layout,
      laneColors: laneColorsFor(layout.laneCount, config.laneColorA, config.laneColorB),
      config: { showSqlPreview: config.showSqlPreview },
    };
    this.emit(this.state);
  }

  /** Re-lays out from the cached graph (no file re-read) + emits. */
  async setExpandCollapsed(v: boolean): Promise<void> {
    const base = this.state?.ui ?? this.deps.getUiPrefs();
    const ui: UiPrefs = { ...base, expandCollapsed: v };
    this.deps.setUiPrefs(ui);

    if (this.state === null || this.cachedGraph === null) return;

    const config = this.deps.getConfig();
    const layout = this.buildLayout(this.cachedGraph, config, v);

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
    // Every persisted pref the webview can replay through `ready.restored` must be compared here,
    // `editLocked` included: a field missing from this list reads as "nothing differs", so the
    // method returns before `setUiPrefs`/`emit` and the restored value is silently dropped — for
    // the lock that means the graph re-locks itself on every reopen no matter how often the user
    // unlocks it. Covered by applyUiPrefs test "f".
    const changed =
      expandChanged ||
      ui.order !== base.order ||
      ui.density !== base.density ||
      ui.axis !== base.axis ||
      ui.editLocked !== base.editLocked;
    if (!changed) return; // true no-op: nothing differs, don't even touch persisted storage

    this.deps.setUiPrefs(ui);
    if (this.state === null) return;

    if (expandChanged && this.cachedGraph !== null) {
      const config = this.deps.getConfig();
      const layout = this.buildLayout(this.cachedGraph, config, ui.expandCollapsed);
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

  /** The active project's `versions/` directory — Task 18's CodeLens provider scopes its
   * DocumentSelector to this (not every `*.py` file in the workspace). Always set: a
   * MigrationService only ever exists for a project that was already resolved to have one (see
   * extension.ts's no-project early return). */
  getVersionsDir(): string {
    return this.deps.project.versionsDir;
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
      // Task 21: keyed off `authorsByPath` directly (not the layout node) so getDetail reflects a
      // just-landed author batch even the instant before its own re-emit lands on `state`.
      author: this.authorsByPath.get(node.filePath) ?? null,
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

  /**
   * Pure over `cachedGraph`: plans a ghost-drag repoint — every broken child of `ghostId` gets an
   * edit pointing at `targetId` (a real revision). Cycle-guarded: rejects if `targetId` equals one
   * of those children, or is a DESCENDANT of any of them (walking `children` forward from each
   * broken child, cycle-safe via a visited-set — same technique `computeAppliedSet`, core/graph.ts,
   * uses walking the other direction) — repointing onto a node that only exists because of the
   * very link being fixed would create a cycle in the DAG. Never mutates anything; `applyRepoint`
   * (services/repoint.ts) is what actually rewrites files from this plan.
   */
  getRepointPlan(ghostId: string, targetId: string): RepointPlan {
    const graph = this.cachedGraph;
    if (graph === null) return { ok: false, reason: "no migration graph loaded yet" };

    const ghost = graph.ghosts.find((g) => g.id === ghostId);
    if (!ghost) return { ok: false, reason: `${ghostId.slice(0, 8)} is not a missing revision` };

    if (!(targetId in graph.nodes)) {
      return { ok: false, reason: `${targetId.slice(0, 8)} is not a real revision` };
    }

    const children = ghost.childIds;
    const visited = new Set<string>();
    const stack = [...children];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const childId of graph.children[id] ?? []) stack.push(childId);
    }
    if (visited.has(targetId)) {
      return { ok: false, reason: "re-pointing would create a cycle" };
    }

    const edits = children.map((id) => ({ revisionId: id, filePath: graph.nodes[id].filePath }));
    return { ok: true, edits };
  }

  /**
   * Pure over `cachedGraph`: plans a freeform topology edit (see `TopologyOp`) as a set of complete
   * `down_revision` rewrites — one per touched file, composed when a single revision is touched by
   * two steps of the same op. Same contract as `getRepointPlan`: never mutates anything, never
   * touches disk, and rejects with a user-facing `reason` rather than producing a graph that would
   * be cyclic, self-referential, or a no-op. The apply layer is what feeds each edit's
   * `newDownRevisions` to `computeDownRevisionsRewrite` (core/downRevisionEdit.ts).
   */
  getTopologyPlan(op: TopologyOp): TopologyPlan {
    const graph = this.cachedGraph;
    if (graph === null) return { ok: false, reason: "no migration graph loaded yet" };

    switch (op.kind) {
      case "move-chain":
        return this.planMoveChain(graph, op);
      case "move-single":
        return this.planMoveSingle(graph, op);
      case "insert-between":
        return this.planInsertBetween(graph, op);
      case "remove-edge":
        return this.planRemoveEdge(graph, op);
    }
  }

  /** `move-chain`: one edit, replacing ALL of the node's parents with the target. Its descendants
   * need no edits at all — they already point at ids inside the subtree, which moves with them. */
  private planMoveChain(graph: MigrationGraph, op: Extract<TopologyOp, { kind: "move-chain" }>): TopologyPlan {
    const rejected = missingRevision(graph, op.nodeId) ?? missingRevision(graph, op.targetId);
    if (rejected !== null) return rejected;
    if (op.targetId === op.nodeId) return { ok: false, reason: "cannot attach a revision to itself" };

    const node = graph.nodes[op.nodeId];
    const descendants = descendantsOf(graph, op.nodeId);
    // Unlike move-single, nothing splices the subtree's internal links first, so a target inside
    // the subtree would end up as both an ancestor and a descendant of the node.
    if (descendants.has(op.targetId)) return { ok: false, reason: "moving would create a cycle" };
    if (sameList(node.downRevisions, [op.targetId])) {
      return { ok: false, reason: `already revises ${short(op.targetId)}` };
    }

    const d = descendants.size;
    const ride = d > 0 ? ` (+${pluralize(d, "descendant", "descendants")})` : "";
    return this.finalizePlan(
      graph,
      new Map([[op.nodeId, [op.targetId]]]),
      `move ${short(op.nodeId)}${ride} under ${short(op.targetId)}`,
    );
  }

  /** `move-single`: splice the node's children onto the node's own parents, then re-parent the node
   * itself. Splicing first is what makes a descendant target legal — by the time the node attaches
   * to it, none of the node's old child links (the ones that would close the loop) remain. */
  private planMoveSingle(graph: MigrationGraph, op: Extract<TopologyOp, { kind: "move-single" }>): TopologyPlan {
    const rejected = missingRevision(graph, op.nodeId) ?? missingRevision(graph, op.targetId);
    if (rejected !== null) return rejected;
    if (op.targetId === op.nodeId) return { ok: false, reason: "cannot attach a revision to itself" };

    const edits: EditMap = new Map();
    spliceChildEdits(graph, graph.nodes[op.nodeId], edits);
    const k = edits.size; // every entry so far is a real (non-identical) child splice
    edits.set(op.nodeId, [op.targetId]);

    const reattach = k > 0 ? `, re-attaching ${pluralize(k, "child", "children")}` : "";
    return this.finalizePlan(graph, edits, `move ${short(op.nodeId)} alone under ${short(op.targetId)}${reattach}`);
  }

  /** `insert-between`: the node takes the edge's parent, and the edge's child swaps that parent for
   * the inserted piece — the subtree's single head in chain mode, the node itself in single mode. */
  private planInsertBetween(
    graph: MigrationGraph,
    op: Extract<TopologyOp, { kind: "insert-between" }>,
  ): TopologyPlan {
    const rejected = missingRevision(graph, op.edgeTo) ?? missingRevision(graph, op.nodeId);
    if (rejected !== null) return rejected;

    if (!graph.nodes[op.edgeTo].downRevisions.includes(op.edgeFrom)) {
      return { ok: false, reason: `${short(op.edgeTo)} does not revise ${short(op.edgeFrom)}` };
    }
    // A ghost edgeFrom is a link to a revision that doesn't exist: there is nothing for the node to
    // revise, so the fix is repoint/remove-edge, not insertion.
    if (!Object.hasOwn(graph.nodes, op.edgeFrom)) {
      return { ok: false, reason: "cannot insert below a missing revision" };
    }
    if (op.nodeId === op.edgeFrom || op.nodeId === op.edgeTo) {
      return { ok: false, reason: "cannot insert a revision into its own link" };
    }

    const descendants = descendantsOf(graph, op.nodeId);
    const edits: EditMap = new Map();
    let inserted: string;

    if (op.mode === "chain") {
      if (descendants.has(op.edgeFrom)) return { ok: false, reason: "inserting would create a cycle" };
      // edgeTo would gain the subtree's head as a parent while already being that head's ancestor.
      if (descendants.has(op.edgeTo)) {
        return { ok: false, reason: "cannot insert a chain into its own descendants" };
      }
      const heads = [op.nodeId, ...descendants].filter((id) => (graph.children[id] ?? []).length === 0);
      if (heads.length !== 1) return { ok: false, reason: `dragged chain has ${heads.length} heads — ambiguous` };
      inserted = heads[0];
    } else {
      spliceChildEdits(graph, graph.nodes[op.nodeId], edits);
      inserted = op.nodeId;
    }

    edits.set(op.nodeId, [op.edgeFrom]);
    // Composed on purpose: in single mode edgeTo may already carry a splice edit (it can be a child
    // of the node AND of edgeFrom), and it must get ONE rewrite carrying both changes.
    const carried = currentParents(graph, edits, op.edgeTo);
    edits.set(op.edgeTo, dedupeFirst(carried.map((id) => (id === op.edgeFrom ? inserted : id))));

    const d = descendants.size;
    const ride = op.mode === "chain" && d > 0 ? ` (+${pluralize(d, "descendant", "descendants")})` : "";
    return this.finalizePlan(
      graph,
      edits,
      `insert ${short(op.nodeId)}${ride} between ${short(op.edgeFrom)} and ${short(op.edgeTo)}`,
    );
  }

  /** `remove-edge`: drop one member of the child's `down_revision`, keeping the rest. The parent may
   * be a ghost (deleting a broken link), and an emptied list is valid — the child becomes a base. */
  private planRemoveEdge(graph: MigrationGraph, op: Extract<TopologyOp, { kind: "remove-edge" }>): TopologyPlan {
    const rejected = missingRevision(graph, op.childId);
    if (rejected !== null) return rejected;

    const child = graph.nodes[op.childId];
    if (!child.downRevisions.includes(op.parentId)) {
      return { ok: false, reason: `${short(op.childId)} does not revise ${short(op.parentId)}` };
    }

    const remaining = child.downRevisions.filter((id) => id !== op.parentId);
    const base = remaining.length === 0 ? " (becomes a new base)" : "";
    return this.finalizePlan(
      graph,
      new Map([[op.childId, remaining]]),
      `stop ${short(op.childId)} revising ${short(op.parentId)}${base}`,
    );
  }

  /** Turns the accumulated per-revision parent lists into `fileEdits`, dropping any that would
   * rewrite a file to what it already says. An op whose every edit is such a no-op has nothing to
   * apply, and is rejected rather than returned as an empty success.
   *
   * Each edit also carries `expectedDownRevisions` — the node's parents as the last scan read
   * them, i.e. the state this whole plan was computed against — so the apply layer can refuse a
   * file that has since changed underneath it (see `TopologyFileEdit`). `graph.nodes[..]` is the
   * right source even for a COMPOSED edit: planning only ever writes to `edits`, never to the
   * graph, so a node touched by two steps still reports the parents its file actually holds.
   *
   * Runs the cycle backstop first, on the FULL edit map — the per-op guards above are kept as-is
   * (they give sharper, op-specific reasons for the cases they do catch), but only a post-edit
   * ancestry walk sees a cycle closed through a link no edited file mentions. See
   * `editedNodeOnCycle`. */
  private finalizePlan(graph: MigrationGraph, edits: EditMap, summary: string): TopologyPlan {
    if (editedNodeOnCycle(graph, edits) !== null) {
      return { ok: false, reason: "edit would create a cycle" };
    }

    const fileEdits: TopologyFileEdit[] = [];
    for (const [revisionId, newDownRevisions] of edits) {
      const node = graph.nodes[revisionId];
      if (sameList(newDownRevisions, node.downRevisions)) continue;
      fileEdits.push({
        revisionId,
        filePath: node.filePath,
        newDownRevisions,
        expectedDownRevisions: node.downRevisions,
      });
    }
    if (fileEdits.length === 0) return { ok: false, reason: "nothing to change" };

    return { ok: true, fileEdits, appliedTouched: this.appliedTouchedFor(graph, fileEdits), summary };
  }

  /**
   * Already-applied revisions on either side of an edit — the edited revision itself plus every id
   * it stops or starts revising. `[]` whenever DB state is unknown (`dbReachable` false): with no
   * applied set there is nothing to warn about, and guessing would be worse than staying silent.
   * Sorted ascending for a stable prompt (and stable tests).
   */
  private appliedTouchedFor(graph: MigrationGraph, fileEdits: TopologyFileEdit[]): string[] {
    if (!this.enrichment.dbReachable) return [];

    const applied = computeAppliedSet(graph, this.enrichment.currentIds);
    const touched = new Set<string>();
    for (const edit of fileEdits) {
      touched.add(edit.revisionId);
      for (const id of graph.nodes[edit.revisionId].downRevisions) touched.add(id);
      for (const id of edit.newDownRevisions) touched.add(id);
    }

    // `applied` only ever contains real node ids (computeAppliedSet drops unknown/ghost ids), so
    // intersecting with it is also what keeps ghost parents out of the result.
    return [...touched].filter((id) => applied.has(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
    this.disposed = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.listeners.clear();
  }
}

// ---------- topology planning helpers (pure, graph-only) ----------

/** Pending new parent list per revision id, in the order the plan first touched each revision —
 * `fileEdits` inherits that order, and re-`set`ting a key composes onto the earlier value in place
 * rather than emitting a second edit for the same file. */
type EditMap = Map<string, string[]>;

/** Display form of a revision id in reasons/summaries — the same 8-char truncation `getRepointPlan`
 * and the webview use. */
function short(id: string): string {
  return id.slice(0, 8);
}

/** `1 child` / `2 children` — both forms are spelled out because English plurals aren't regular. */
function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** The rejection for an id that has to name a real revision but doesn't, or null if it does. */
function missingRevision(graph: MigrationGraph, id: string): { ok: false; reason: string } | null {
  return Object.hasOwn(graph.nodes, id) ? null : { ok: false, reason: `${short(id)} is not a real revision` };
}

/** True when two parent lists are identical (same ids, same order) — arity and order are both
 * meaningful in a `down_revision` tuple, so this is a plain element-wise comparison. */
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Duplicates removed, FIRST occurrence kept — a rewritten parent list must never name the same
 * revision twice (alembic would treat it as a two-parent merge onto one revision). */
function dedupeFirst(ids: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  return kept;
}

/** STRICT descendants of `id` — the walk starts at `id`'s children, so `id` itself is in the result
 * only if a pre-existing cycle leads back to it. Forward walk of `children` with a visited set,
 * cycle-safe the same way `getRepointPlan`'s walk and `computeAppliedSet` are. */
function descendantsOf(graph: MigrationGraph, id: string): Set<string> {
  const visited = new Set<string>();
  const stack = [...(graph.children[id] ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const childId of graph.children[current] ?? []) stack.push(childId);
  }
  return visited;
}

/** `id`'s parent list as the plan has it so far: a pending edit if one exists, else what the file
 * currently says. The planners themselves only ever pass real revision ids; the `?.`/`?? []` is for
 * `editedNodeOnCycle`, whose ancestor walk can reach a GHOST parent — an id no file declares, which
 * therefore has no parents of its own and simply ends that branch of the walk. */
function currentParents(graph: MigrationGraph, edits: EditMap, id: string): string[] {
  return edits.get(id) ?? graph.nodes[id]?.downRevisions ?? [];
}

/**
 * Cycle BACKSTOP over a complete edit map: returns an edited revision that would end up as its own
 * ancestor once every edit lands, or null if none would.
 *
 * The per-op guards each reason about one op's own shape (is the target a descendant? is the
 * dragged chain's head inside edgeTo's subtree?), which misses cycles closed by a link NO edited
 * file even mentions. The verified case: A <- B <- D <- M with M also revising X. Inserting X's
 * chain into the A -> B link plans X -> [A] and B -> [M], and M's untouched D parent then closes
 * M -> B -> D -> M. Nothing short of walking the POST-EDIT ancestry can see that, so this runs over
 * the finished edit map in `finalizePlan` and every op — current and future — inherits it.
 *
 * Deliberately scoped to EDITED nodes only, never a whole-graph acyclicity check: a broken repo can
 * already contain a cyclic island (buildGraph and layoutGraph both tolerate one by design), and
 * rejecting unrelated edits — or, worse, the remove-edge that REPAIRS such a cycle — because of it
 * would be a regression. An edited node that sits on a pre-existing cycle the edit does not resolve
 * is still reported, which is correct: applying it would write that cycle back out.
 *
 * One deliberate over-report follows from running BEFORE `finalizePlan`'s no-op filter: an entry
 * whose new parent list already equals what the file says — a file that would never be written —
 * can still trigger the rejection, turning a would-be `nothing to change` into
 * `edit would create a cycle`. Accepted, because it errs toward refusing to act on a component
 * that is already cyclic and the message is not wrong about the graph's state.
 */
function editedNodeOnCycle(graph: MigrationGraph, edits: EditMap): string | null {
  for (const id of edits.keys()) {
    // Fresh per start node: a shared visited set would let one node's exhausted walk hide a later
    // node's route back to itself.
    const visited = new Set<string>();
    const stack = [...currentParents(graph, edits, id)];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === id) return id;
      if (visited.has(current)) continue; // a cycle NOT through `id` — bounded, keep walking elsewhere
      visited.add(current);
      for (const parentId of currentParents(graph, edits, current)) stack.push(parentId);
    }
  }
  return null;
}

/** Records the edits that splice `node` out from under its children: each child swaps `node` for
 * `node`'s own parents, so the chain stays connected (and a child of a root correctly ends up with
 * an empty list, i.e. `down_revision = None`). Children whose list is unchanged get no edit. */
function spliceChildEdits(graph: MigrationGraph, node: RevisionNode, edits: EditMap): void {
  for (const childId of graph.children[node.revision] ?? []) {
    const parents = currentParents(graph, edits, childId);
    const spliced = dedupeFirst(parents.flatMap((id) => (id === node.revision ? node.downRevisions : [id])));
    if (!sameList(spliced, parents)) edits.set(childId, spliced);
  }
}

/** Hue-rotation step (degrees) between each lane >= 2's color and lane 1's — see `rotateHue`. */
const LANE_HUE_STEP_DEG = 40;

/**
 * Array of length max(laneCount, 1): lane 0 = laneColorA, lane 1 = laneColorB, every lane after
 * that hue-rotates laneColorB by `LANE_HUE_STEP_DEG` more per lane (Task 21) — so a graph with many
 * concurrent branches gets a visually distinct (if not infinitely distinguishable) color per lane
 * instead of every branch past the first two silently reusing laneColorB.
 *
 * Exported (not just for `laneColorsFor` call sites inside this class) so it's directly
 * unit-testable without needing a fixture graph with >= 3 lanes. Independently re-validates both
 * colors against `isValidHex` (falling back to the hardcoded defaults, matching the setting
 * declarations in package.json) even though extension.ts's config read already does the same at
 * the source — belt and suspenders: this function must never propagate a NaN-producing string
 * into a hue rotation, regardless of what validation any particular caller did or didn't do.
 */
export function laneColorsFor(laneCount: number, laneColorA: string, laneColorB: string): string[] {
  const a = isValidHex(laneColorA) ? laneColorA : DEFAULT_LANE_COLOR_A;
  const b = isValidHex(laneColorB) ? laneColorB : DEFAULT_LANE_COLOR_B;
  const length = Math.max(laneCount, 1);
  return Array.from({ length }, (_, i) => {
    if (i === 0) return a;
    if (i === 1) return b;
    return rotateHue(b, LANE_HUE_STEP_DEG * (i - 1));
  });
}
