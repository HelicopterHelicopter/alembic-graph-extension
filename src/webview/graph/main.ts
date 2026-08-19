/**
 * Graph webview entry point. Owns the small client-side store (current AppState + locally
 * selected id) and wires host <-> webview messaging to render.ts. Detail-panel consumption of
 * "select" (Task 10) and persistence/restore of UI prefs, selection, and scroll (Task 11) build
 * on this file without needing structural changes here.
 */
import "./graph.css";
import { onMessage, post, getPersisted, setPersisted } from "../shared/vscodeApi";
import { applyBusyMessage } from "../../core/broadcastGate";
import type { AppState, RevisionDetail, TopologyOp, UiPrefs } from "../../protocol/messages";
import type { LayoutNode } from "../../core/types";
import { render, showToast, type Handlers, type ViewState } from "./render";
import { canvasSize, edgePathD, nodeAnchor, nodeSize, nodeXY } from "./metrics";
import { buildGraphSvg } from "./svgExport";
import { attachDnd, type DndCallbacks } from "./dnd";
import { openDropChoice } from "./dropChoice";
import { attachContextMenu, closeContextMenu, isContextMenuOpen, type MenuHandlers } from "./contextMenu";
import { attachSearch, type SearchableCard, type SearchCallbacks } from "./search";
import { attachHover, clearActiveHover, type HoverCallbacks } from "./hover";
import { attachKeyboardNav, type KeyboardNavHandlers } from "./keyboardNav";
import { captureFlipSnapshot, playEdgesFade, playFlip } from "./flip";
import {
  ZOOM_DEFAULT,
  chainMoveCount,
  clampZoom,
  computeDescendantSet,
  fitScroll,
  fitZoom,
  matchesQuery,
  stepZoom,
  zoomAnchorScroll,
  type NavNode,
  type ScrollPoint,
} from "./uxMath";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("alembic graph webview: missing #app root element");
const app: HTMLElement = appRoot;

/**
 * Shape persisted via `vscode.setState`/`getState` (survives tab hide + window reload while the
 * panel's tab exists — see shared/vscodeApi.ts). All fields optional/independently defaulted on
 * read so this shape can grow (e.g. Task 19's zoom) without migrating old persisted state.
 */
interface PersistedUiState {
  order?: UiPrefs["order"];
  density?: UiPrefs["density"];
  expandCollapsed?: boolean;
  /** Task H: graph axis, persisted exactly like order/density (webview setState + workspaceState
   * via the host's UiPrefs plumbing — see `restoredPrefs`/`applyUiPrefs`). */
  axis?: UiPrefs["axis"];
  /** Edit-mode lock, persisted exactly like axis above (webview setState + workspaceState via the
   * host's UiPrefs plumbing). Absent — an old snapshot, or one written before this field existed —
   * means the host's own default (locked) stands, which is the safe direction to fail. */
  editLocked?: boolean;
  selectedId?: string | null;
  detailOpen?: boolean;
  scrollTop?: number;
  scrollLeft?: number;
  /** Task 19: canvas zoom [0.5, 1.5] — webview-local (never round-tripped through the host's
   * UiPrefs), unlike order/density/expandCollapsed/axis above. */
  zoom?: number;
}

const store: {
  state: AppState | null;
  selectedId: string | null;
  detail: RevisionDetail | null;
  detailOpen: boolean;
  /** Operations (per the "busy" message's `operation` field) currently running host-side —
   * non-empty disables drag start (dnd.ts's `isEnabled()`) and shows the toolbar's busy
   * indicator. Populated/drained by the "busy" case in onMessage below. */
  busyOps: Set<string>;
  /** Task 19: canvas scale factor, persisted (see PersistedUiState.zoom) but never sent to the
   * host — zoom is purely a webview presentation concern. */
  zoom: number;
  /** Task 19: search box state, preserved across a re-render (brief: "State re-render preserves
   * the query") but deliberately NOT persisted via setPersisted/PersistedUiState — the brief marks
   * cross-reload persistence out of scope, session-only is fine. `index` is the last cycle
   * position (-1 = none yet, i.e. no Enter press since the query last changed); see search.ts. */
  search: { query: string; index: number };
} = {
  state: null,
  selectedId: null,
  detail: null,
  detailOpen: false,
  busyOps: new Set(),
  zoom: ZOOM_DEFAULT,
  search: { query: "", index: -1 },
};

/**
 * True from the instant a drag exceeds the pointer-move threshold (dnd.ts) until it fully ends
 * (drop, revert, or cancel). While true, incoming "state" messages are stashed in `pendingState`
 * instead of triggering a re-render — render() rebuilds the canvas wholesale, which would orphan
 * the card currently holding pointer capture mid-drag. See `dndCallbacks.onDragActiveChange`.
 *
 * Every OTHER message handler that would otherwise call `renderStore()` directly (busy, detail,
 * selectNode, busyReset — none of which carry a fresh AppState to stash in `pendingState`) routes
 * through `requestRender()` instead, which sets `pendingRender` the same way — see its doc
 * comment below for why a bare boolean flag is enough there. Final-review fix: this used to be
 * true only of the "state" case; those four handlers called `renderStore()` unconditionally,
 * so a re-render arriving mid-drag (e.g. a stale `busy:false` for a dismissed "Merge Heads…" input
 * box landing while the user is mid-drag on an unrelated head) would tear down the canvas, orphan
 * the pointer-captured card, and leave `dragActive` wedged true forever — silently freezing the
 * panel (no further "state" push would ever render again).
 */
let dragActive = false;
/** Latest "state" message received while `dragActive` — applied the moment the drag ends. Only
 * ever holds at most one entry: a second stash while still dragging simply overwrites the first,
 * since only the newest state matters once we do re-render. */
let pendingState: AppState | null = null;
/** Set by `requestRender()` while `dragActive` — see that function's doc comment. Flushed (a
 * plain `renderStore()`) by `dndCallbacks.onDragActiveChange(false)` once the drag ends, unless
 * `pendingState` ALSO arrived meanwhile, in which case `applyState`'s own `renderStore()` call
 * already covers it and this is just cleared without a second, redundant render. */
let pendingRender = false;
/** Set by the "selectNode" case while `dragActive`, mirroring `pendingRender` but for
 * `scrollNodeIntoView`'s side effect specifically: it reads the just-rendered canvas' layout to
 * compute a scroll position, so it must run AFTER whatever render eventually applies, never
 * before — flushed by `onDragActiveChange(false)` right after the deferred render (if any). */
let pendingScrollId: string | null = null;

/**
 * Extra guard beyond `store.busyOps`, closing the narrow race between a drop posting "merge" and
 * the host's "busy" response: mergeHeadsAction (src/ui/actions.ts) shows an interactive
 * `showInputBox` BEFORE ever posting `busy:true`, so there's a real, human-timescale window after
 * a drop where `store.busyOps` is still empty and a second drag could start. Armed the instant a
 * drop fires, carrying a webview-generated `busyToken` the host echoes back in every busy message
 * for that invocation (see the merge/repoint/topologyEdit messages' comment in
 * protocol/messages.ts); disarmed ONLY by a merge/repoint/topology `busy:false` whose token MATCHES
 * the arming drop's — the drop's own transaction ending. Matching by token (not just operation name)
 * matters because a stale busy:false from a switched-away-from project is deliberately still
 * delivered (core/broadcastGate.ts) and must not disarm a freshly-armed guard in the new project —
 * the double-drop race this guard exists for would reopen exactly during mergeHeadsAction's
 * showInputBox window. The freeform topology gestures need the same protection for the same reason:
 * topologyEditAction can sit on a modal "rewrite already-applied history?" confirmation before any
 * busy:true. The host guarantees that terminal busy:false on EVERY merge/repoint/topology outcome,
 * including a cancelled input box, a dismissed modal, and pre-busy validation aborts (see
 * mergeHeadsAction/repointAction/topologyEditAction) — the generous fixed timeout below stays as a
 * belt-and-suspenders floor so a dropped message can never wedge dragging off forever.
 */
let dropGuardActive = false;
let dropGuardTimer: ReturnType<typeof setTimeout> | null = null;
/** The `busyToken` the currently-armed drop posted with — the only token whose terminal
 * busy:false may disarm the guard. Null whenever the guard is disarmed. */
let armedDropToken: string | null = null;
let dropTokenSeq = 0;
const DROP_GUARD_TIMEOUT_MS = 30000;

/** Arms the guard for one drop/click and returns the fresh token to post with. */
function armDropGuard(): string {
  const token = `drop#${++dropTokenSeq}`;
  dropGuardActive = true;
  armedDropToken = token;
  if (dropGuardTimer !== null) clearTimeout(dropGuardTimer);
  dropGuardTimer = setTimeout(() => {
    dropGuardTimer = null;
    dropGuardActive = false;
    armedDropToken = null;
  }, DROP_GUARD_TIMEOUT_MS);
  return token;
}

function clearDropGuard(): void {
  dropGuardActive = false;
  armedDropToken = null;
  if (dropGuardTimer !== null) {
    clearTimeout(dropGuardTimer);
    dropGuardTimer = null;
  }
}

/** Last known canvas scroll position. The single source of truth `persist()` reads from — the
 * canvas DOM is torn down and rebuilt wholesale on every render(), so scroll can't be read lazily
 * at persist time without risking a just-detached element. Seeded from persisted state (if any)
 * at module load, then kept in sync by renderStore()'s preserve-scroll step and the throttled
 * scroll listener below. */
let lastScroll = { scrollTop: 0, scrollLeft: 0 };

/** Read once, synchronously, before any message can arrive. Non-null only when this exact
 * webview tab previously called `setPersisted`. */
const persisted = getPersisted<PersistedUiState>();
if (persisted) {
  store.selectedId = persisted.selectedId ?? null;
  store.detailOpen = persisted.detailOpen ?? false;
  lastScroll = { scrollTop: persisted.scrollTop ?? 0, scrollLeft: persisted.scrollLeft ?? 0 };
  store.zoom = clampZoom(persisted.zoom ?? ZOOM_DEFAULT);
}

/** Flips true after the first "state" message is processed — gates the one-time restored-
 * selection reconciliation (guard existence, refetch detail) so it never re-runs on later state
 * updates. The store's order/density/expandCollapsed always mirror the last received
 * `state.ui` — the host remains authoritative for those after `ready`. */
let firstStateHandled = false;

const handlers: Handlers = {
  onSelect(id) {
    store.selectedId = id;
    // Clear the previous selection's detail immediately so a stale panel never hangs around
    // attached to the wrong card while the host's async response for the new id is in flight.
    store.detail = null;
    store.detailOpen = true;
    post({ type: "select", id });
    renderStore();
  },
  onToggleOrder(order) {
    post({ type: "setOrientation", order });
  },
  onToggleDensity(density) {
    post({ type: "setDensity", density });
  },
  onToggleAxis(axis) {
    post({ type: "setAxis", axis });
  },
  onToggleEditLocked(locked) {
    // No optimistic store update, same as the toggles above: the host flips the pref and re-emits
    // state, so the toolbar's active toggle and the lock the gesture gates actually read can never
    // drift apart.
    post({ type: "setEditLocked", editLocked: locked });
  },
  onExpandCollapse() {
    post({ type: "expandCollapse" });
  },
  onCloseDetail() {
    // Design's `closeDetails`: hides the panel but leaves the card selection/highlight alone.
    store.detailOpen = false;
    renderStore();
  },
  onOpenFile(id) {
    post({ type: "openFile", id });
  },
  onNavigateToRevision(id) {
    // Detail panel's down_revision links: jump to the parent revision exactly like a sidebar/
    // CodeLens selectNode would.
    selectAndCenterNode(id);
  },
  onNewRevision() {
    // Belt-and-suspenders with render.ts's --disabled styling (pointer-events:none) — same
    // convention as the sidebar's onUpgrade guard (src/webview/sidebar/main.ts).
    if (store.busyOps.size > 0) return;
    post({ type: "newRevision" });
  },
  onZoomIn() {
    applyZoom(stepZoom(store.zoom, 1));
  },
  onZoomOut() {
    applyZoom(stepZoom(store.zoom, -1));
  },
  onZoomReset() {
    applyZoom(ZOOM_DEFAULT);
  },
  onZoomFit() {
    if (!store.state) return;
    const viewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
    if (!viewport) return;
    const size = canvasSize(store.state.layout, store.state.ui, store.state.ui.density);
    const viewportSize = { w: viewport.clientWidth, h: viewport.clientHeight };
    const zoom = fitZoom(size, viewportSize);
    const scroll = fitScroll(size, viewportSize, zoom);
    store.zoom = zoom;
    renderStore(scroll);
  },
  onExportSvg() {
    // Belt-and-suspenders with render.ts's --disabled styling (pointer-events:none), same
    // convention as onNewRevision above — a stray click during a busy window is a silent no-op.
    if (!store.state || store.busyOps.size > 0) return;
    const svg = buildGraphSvg({
      layout: store.state.layout,
      laneColors: store.state.laneColors,
      ui: store.state.ui,
      counts: store.state.counts,
      projectLabel: store.state.project?.label ?? "",
    });
    post({ type: "exportSvg", svg });
  },
  onRestoreFile(ghostId) {
    // Task B2: belt-and-suspenders with render.ts's --disabled styling on the button itself, same
    // busy-guard convention as onNewRevision/onExportSvg above.
    if (store.busyOps.size > 0) return;
    post({ type: "restoreFile", ghostId });
  },
  onMergeAllHeads(ids) {
    // N-way task: the merge-hint banner's "Merge all N heads" button (heads >= 3) — belt-and-
    // suspenders with render.ts's --disabled styling on the button itself (same busy-guard
    // convention as onNewRevision/onExportSvg/onRestoreFile above), PLUS `dropGuardActive`: a
    // click lands here through the same "posts merge, then waits on mergeHeadsAction's
    // showInputBox before any busy:true" window a drag drop does (see dropGuardActive's own doc
    // comment) — arming the guard exactly like `dndCallbacks.onMergeDrop` below closes that same
    // narrow double-fire race for the button, not just the drag gesture.
    if (store.busyOps.size > 0 || dropGuardActive) return;
    post({ type: "merge", ids, busyToken: armDropGuard() });
  },
};

/**
 * Applies `newZoom` (clamped), preserving the content point at `anchor` (viewport-relative,
 * unscrolled offset) — or the viewport center if no anchor is given, e.g. a toolbar button click
 * rather than a cursor-anchored wheel zoom. A no-op if the clamped value doesn't actually change
 * the current zoom (avoids a pointless re-render at the 0.5/1.5 clamp boundary).
 */
function applyZoom(newZoom: number, anchor?: { offsetX: number; offsetY: number }): void {
  const clamped = clampZoom(newZoom);
  if (clamped === store.zoom) return;

  const viewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  let scrollOverride: ScrollPoint | undefined;
  if (viewport) {
    const resolvedAnchor = anchor ?? { offsetX: viewport.clientWidth / 2, offsetY: viewport.clientHeight / 2 };
    scrollOverride = zoomAnchorScroll(
      { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop },
      resolvedAnchor,
      store.zoom,
      clamped,
    );
  }
  store.zoom = clamped;
  renderStore(scrollOverride);
}

/** Ctrl/Cmd+wheel on the viewport zooms, anchored at the cursor; a plain wheel keeps scrolling
 * (the browser's default). Re-attached every render, same as attachDnd/attachContextMenu below —
 * the viewport is a fresh element each time.
 *
 * Critical fix (Task 19 review, finding 1): while `dragActive`, a ctrl/cmd+wheel is swallowed
 * entirely — NOT applied and NOT queued. `applyZoom` -> `renderStore()` rebuilds the canvas
 * wholesale (see renderStore's header comment), which would detach the card currently holding
 * pointer capture mid-drag; dnd.ts's `endDrag`/pointer handlers would then never fire again on that
 * detached element, wedging `dragActive` true forever (state pushes stashed forever, context menu
 * and hover permanently gated — see the `dragActive` doc comment above). `preventDefault` still
 * fires so the browser doesn't fall back to its own page-zoom gesture. */
function attachZoomWheel(viewport: HTMLElement): void {
  viewport.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (dragActive) return;
      const direction: 1 | -1 = e.deltaY < 0 ? 1 : -1;
      const rect = viewport.getBoundingClientRect();
      applyZoom(stepZoom(store.zoom, direction), { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top });
    },
    { passive: false },
  );
}

/** search.ts's callbacks (Task 19) — persists `{query, index}` on the store (so a later
 * host-driven re-render doesn't lose the in-progress query/cycle position, per the brief) and
 * reuses the existing centering helper for Enter/Shift+Enter cycling. Deliberately does NOT call
 * renderStore() itself — see search.ts's header comment for why a full re-render on every
 * keystroke would break typing. */
const searchCallbacks: SearchCallbacks = {
  onStateChange(query, index) {
    store.search = { query, index };
  },
  onNavigate(id) {
    scrollNodeIntoView(id);
  },
};

/** hover.ts's suppression gate (Task 19) — per the brief: dragging, an open context menu, or
 * active search dimming (search wins) all suppress ancestry highlight. */
const hoverCallbacks: HoverCallbacks = {
  isSuppressed() {
    return dragActive || isContextMenuOpen() || store.search.query.trim() !== "";
  },
};

/** keyboardNav.ts's handlers (Task 19). `onNavigate` is the one case that can't just be a typed
 * post (see keyboardNav.ts's header comment): it needs to select AND, once the resulting
 * synchronous re-render has replaced the DOM, focus + scroll the FRESH card into view.
 * Final-review fix: all handlers early-return if dragActive — navigating/toggling/escaping
 * mid-drag would call renderStore(), rebuilding the canvas and orphaning the pointer-captured card. */
const keyboardHandlers: KeyboardNavHandlers = {
  onNavigate(id) {
    if (dragActive) return;
    navigateToNode(id);
  },
  onOpenFile(id) {
    if (dragActive) return;
    handlers.onOpenFile(id);
  },
  onToggleDetail() {
    if (dragActive) return;
    store.detailOpen = !store.detailOpen;
    renderStore();
  },
  onEscape() {
    if (dragActive) return;
    if (store.detailOpen) {
      store.detailOpen = false;
      renderStore();
      return;
    }
    if (store.selectedId !== null) {
      store.selectedId = null;
      store.detail = null;
      post({ type: "select", id: null });
      renderStore();
    }
  },
};

/** Selects `id` exactly like a click (post + detail fetch + re-render — `handlers.onSelect` is
 * synchronous, so the DOM is already rebuilt by the time it returns), then focuses and centers the
 * FRESH card. Re-queries the viewport/card from `document` rather than closing over anything from
 * before the select — the pre-select viewport is detached the instant `renderStore()` runs inside
 * `onSelect` (render.ts replaces the canvas wholesale on every call). */
function navigateToNode(id: string): void {
  handlers.onSelect(id);
  scrollNodeIntoView(id);
  const viewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  const card = viewport?.querySelector<HTMLElement>(`.alx-card[data-node-id="${CSS.escape(id)}"]`);
  card?.focus({ preventScroll: true });
}

/** Revision (kind === "revision") nodes adapted to search.ts's `SearchableCard` shape. Ghost/
 * collapse placeholders are never search targets — the brief's match rules (hash/message/author/
 * branchLabel) are revision-card fields. */
function searchableCards(state: AppState): SearchableCard[] {
  return state.layout.nodes
    .filter((n) => n.kind === "revision")
    .map((n) => ({ id: n.id, hash: n.hash, message: n.message, author: n.author, branchLabel: n.branchLabel }));
}

/** Revision nodes adapted to uxMath's `NavNode` shape for keyboardNav.ts — same revision-only
 * scoping as `searchableCards` (ghost/collapse cards get no tabindex, see render.ts, so they're
 * never a keyboard-nav origin or destination).
 *
 * Minor fix (Task 19 review, finding 4): while a search query is active, cards that don't match it
 * are dimmed (search.ts's `.alx-card--dimmed`) but arrow-key navigation used to ignore that
 * entirely, landing on dimmed cards same as lit ones. Excluding non-matching cards here scopes
 * `findRowNeighbor`/`findLaneNeighbor`'s candidate pool to only the lit (matching) cards. If every
 * card is dimmed (or the currently-focused card itself no longer matches), navigation simply
 * doesn't move — keyboardNav.ts's `nodes.find(...)` fails to resolve `current` and the keydown is a
 * no-op, same as any other "no neighbor in that direction" case. */
function navNodes(state: AppState): NavNode[] {
  const query = store.search.query.trim();
  const revisionNodes = state.layout.nodes.filter((n) => n.kind === "revision");
  const visible = query === "" ? revisionNodes : revisionNodes.filter((n) => matchesQuery(query, n));
  return visible.map((n) => ({ id: n.id, lane: n.lane, row: n.row }));
}

/** contextMenu.ts's per-item handlers — each just posts the corresponding typed message; the
 * confirm modal / QuickPick / clipboard write all live host-side (src/ui/actions.ts,
 * src/ui/graphPanel.ts). `onOpenFile` intentionally reuses the exact same handler as the detail
 * panel's file row (`handlers.onOpenFile` above) rather than a second copy. */
const menuHandlers: MenuHandlers = {
  onUpgradeTo(id) {
    post({ type: "upgradeTo", id });
  },
  onDowngradeTo(id) {
    post({ type: "downgradeTo", id });
  },
  onPreviewSql(id) {
    post({ type: "previewSql", id });
  },
  onCopyId(id) {
    post({ type: "copyId", id });
  },
  onOpenFile(id) {
    handlers.onOpenFile(id);
  },
  onRemoveEdge(from, to) {
    // Freeform-topology task: the edge menu's one item. `from` is the parent/older side of the
    // link, `to` the child that revises it — i.e. `to`'s file is the one whose `down_revision` the
    // host rewrites. Guard-armed like every other drop-initiated post (see postTopologyEdit): the
    // host may sit on a "rewrite already-applied history?" modal before any busy:true.
    postTopologyEdit({ kind: "remove-edge", parentId: from, childId: to });
  },
};

/**
 * Bug fix: live-updates just the `<path>` elements touching `nodeId` while it's being dragged
 * (dnd.ts's `onDragMove`, rAF-throttled there) — WITHOUT re-rendering, which would tear down the
 * card currently holding pointer capture (see `dragActive`'s doc comment). Recomputes each
 * affected edge's `d` from the SAME pure metrics.ts math render.ts's `computePositions`/
 * `buildEdgesSvg` use, with `nodeId`'s endpoint alone nudged by `(dxCanvas, dyCanvas)` (already
 * zoom-divided by dnd.ts — see its module doc comment) via `nodeAnchor`'s override params; the
 * OTHER endpoint of each edge is left at its plain, unmodified position. Deliberately reads
 * `data-from`/`data-to` (already set by render.ts's `buildEdgesSvg` for hover.ts) rather than
 * measuring the DOM — `getBoundingClientRect()` is zoom-scaled and would need an inverse
 * conversion for no benefit over just reusing the same pixel math the SVG was built from. A no-op
 * if there's no current state/viewport (defensive — shouldn't happen while a drag is live) or no
 * edge touches this node (a lone/root/leaf-only drag).
 *
 * The attribute-keyed query below deliberately carries NO class filter, so it matches BOTH paths
 * render.ts emits per parent link: the visible `.alx-edge` and its invisible `.alx-edge-hit` twin
 * (same `data-from`/`data-to`). That is what keeps an edge's pointer hit area glued to the curve
 * while a card is being dragged around — verified, not incidental.
 */
function updateDraggedEdges(nodeId: string, dxCanvas: number, dyCanvas: number): void {
  if (!store.state) return;
  const svg = document.querySelector<SVGSVGElement>(".alx-canvas-viewport .alx-edges");
  if (!svg) return;
  const paths = svg.querySelectorAll<SVGPathElement>(
    `path[data-from="${CSS.escape(nodeId)}"], path[data-to="${CSS.escape(nodeId)}"]`,
  );
  if (paths.length === 0) return;

  const { layout, ui } = store.state;
  const density = ui.density;
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const path of paths) {
    const fromId = path.dataset.from;
    const toId = path.dataset.to;
    if (!fromId || !toId) continue;
    const fromNode = nodeById.get(fromId);
    const toNode = nodeById.get(toId);
    if (!fromNode || !toNode) continue;
    const fromAnchor = nodeAnchor(
      fromNode,
      ui,
      layout.rowCount,
      density,
      fromId === nodeId ? dxCanvas : 0,
      fromId === nodeId ? dyCanvas : 0,
    );
    const toAnchor = nodeAnchor(
      toNode,
      ui,
      layout.rowCount,
      density,
      toId === nodeId ? dxCanvas : 0,
      toId === nodeId ? dyCanvas : 0,
    );
    path.setAttribute("d", edgePathD(fromAnchor, toAnchor, ui.axis));
  }
}

/** The VISIBLE `.alx-edge` path drawn for the same parent link as the `.alx-edge-hit` twin `hit`
 * (identical `data-from`/`data-to`, see render.ts's buildEdgesSvg) — the twin itself is transparent,
 * so every edge highlight class goes on the drawn sibling. */
function visibleEdgeTwin(viewport: HTMLElement, hit: SVGElement): SVGPathElement | null {
  const from = hit.dataset.from;
  const to = hit.dataset.to;
  if (!from || !to) return null;
  return viewport.querySelector<SVGPathElement>(
    `path[data-from="${CSS.escape(from)}"][data-to="${CSS.escape(to)}"]:not(.alx-edge-hit)`,
  );
}

/**
 * Freeform-topology task: hovering a parent link highlights it (`alx-edge--hover`), so an edge
 * reads as something you can act on — right-click it for "Remove link", or drop a revision on it to
 * splice that revision in. Delegated on the viewport and re-attached every render, same as every
 * other listener here (the canvas is rebuilt wholesale each time), and driven by pointerover/
 * pointerout on the fat invisible `.alx-edge-hit` twins, which are the only thing in the edge layer
 * that receives pointer events at all (graph.css).
 *
 * Suppressed while a drag is active: the drag machine owns edge highlighting then, with its own
 * `alx-edge--drop-target` on whichever edge is a legal drop. `pointerout` is deliberately NOT gated
 * the same way — it must stay able to clean up a highlight applied before the drag started.
 */
function attachEdgeHover(viewport: HTMLElement): void {
  viewport.addEventListener("pointerover", (e: PointerEvent) => {
    if (dragActive) return;
    const hit = (e.target as Element).closest<SVGElement>(".alx-edge-hit");
    if (!hit) return;
    visibleEdgeTwin(viewport, hit)?.classList.add("alx-edge--hover");
  });
  viewport.addEventListener("pointerout", (e: PointerEvent) => {
    const hit = (e.target as Element).closest<SVGElement>(".alx-edge-hit");
    if (!hit) return;
    visibleEdgeTwin(viewport, hit)?.classList.remove("alx-edge--hover");
  });
}

/** Drops any edge hover highlight currently applied, wherever it is — used when a drag starts (see
 * `dndCallbacks.onDragActiveChange`), which is the one moment `pointerout` can't be relied on. */
function clearEdgeHover(): void {
  for (const path of document.querySelectorAll<SVGPathElement>(".alx-edge--hover")) {
    path.classList.remove("alx-edge--hover");
  }
}

/** The layout node with `id`, or null when the current state has none — the shared lookup behind
 * the freeform drag's info callback and its head-on-head drop decision. */
function layoutNodeById(id: string): LayoutNode | null {
  return store.state?.layout.nodes.find((n) => n.id === id) ?? null;
}

/** Whether the edit-mode lock is currently ON (UiPrefs.editLocked) — the single place the webview
 * reads it, so every gesture gate below agrees by construction. Defaults to LOCKED when there is no
 * state yet (before the first "state" message): the lock exists to stop an accidental drag from
 * rewriting migration files, so "we don't know yet" must fail closed. Deliberately NOT folded into
 * `dndCallbacks.isEnabled()` — see that callback's `isEditLocked` doc comment in dnd.ts. */
function isEditLocked(): boolean {
  return store.state?.ui.editLocked ?? true;
}

/** Posts one freeform topology edit (freeform-topology task). Every freeform gesture funnels
 * through here, so the "exactly one `armDropGuard()` per posted message, at post time only"
 * invariant (see dropGuardActive's doc comment) is stated in exactly one place — in particular the
 * drop-choice popover arms nothing until a choice is actually picked, and dismissing it posts
 * nothing at all. */
function postTopologyEdit(op: TopologyOp): void {
  post({ type: "topologyEdit", op, busyToken: armDropGuard() });
}

/** dnd.ts's hooks into this store — see the module doc comments on `dragActive`/`dropGuardActive`
 * above for why each exists. */
const dndCallbacks: DndCallbacks = {
  isEnabled() {
    return store.busyOps.size === 0 && !dropGuardActive;
  },
  isEditLocked,
  onMergeDrop(a, b) {
    // N-way task: the protocol's "merge" message now always carries `ids` (length 2 for a plain
    // drag-drop) — see protocol/messages.ts's doc comment. Freeform-topology task: dnd.ts no longer
    // calls this itself (there is no merge drag kind anymore) — the one caller is the head-on-head
    // drop popover in `onFreeformDrop` below, which reuses this rather than repeating the post.
    post({ type: "merge", ids: [a, b], busyToken: armDropGuard() });
  },
  getFreeformInfo(nodeId) {
    const layout = store.state?.layout;
    const node = layoutNodeById(nodeId);
    // Ghost and collapse placeholders have no migration file to rewrite, so they are not freeform
    // drag sources. render.ts already withholds the drag affordance from them (only `.alx-card`
    // revision cards get it) — this is the defensive second gate dnd.ts asks for, which also covers
    // an id the current layout no longer contains.
    if (!layout || !node || node.kind !== "revision") return null;
    return {
      chainCount: chainMoveCount(nodeId, layout.nodes, layout.edges),
      descendantIds: [...computeDescendantSet(nodeId, layout.edges)],
      isMerge: node.isMerge,
      isHead: node.isHead,
    };
  },
  onFreeformDrop(nodeId, drop, mode, at) {
    if (drop.kind === "node" && mode === "chain" && drop.targetIsHead && layoutNodeById(nodeId)?.isHead === true) {
      // Head onto head, whole chain: the one genuinely ambiguous drop — it reads equally as "merge
      // these two heads" (the original Task 14 gesture, which creates a merge revision and keeps
      // both histories) and as "move this chain under that one" (which rewrites this head's
      // down_revision). Ask instead of guessing. `targetId` is destructured out because TypeScript
      // drops the `drop.kind === "node"` narrowing inside the closures below (a parameter is a
      // mutable binding), and a `const` keeps it.
      const { targetId } = drop;
      openDropChoice(at, [
        {
          label: "Merge heads",
          onPick() {
            // Re-gated at pick time, not just at drop time: a popover can sit open indefinitely,
            // and an unrelated operation (or another drop) may have started meanwhile — or the user
            // may have re-locked editing from the toolbar, which a popover left standing from
            // before the flip would otherwise happily ignore (defense in depth: a locked drag can't
            // start in the first place, so this popover can only exist unlocked).
            if (!dndCallbacks.isEnabled() || isEditLocked()) return;
            dndCallbacks.onMergeDrop(nodeId, targetId);
          },
        },
        {
          label: "Move here",
          onPick() {
            if (!dndCallbacks.isEnabled() || isEditLocked()) return;
            postTopologyEdit({ kind: "move-chain", nodeId, targetId });
          },
        },
      ]);
      return;
    }

    postTopologyEdit(
      drop.kind === "node"
        ? { kind: mode === "chain" ? "move-chain" : "move-single", nodeId, targetId: drop.targetId }
        : // An edge drop splices the dragged revision into that parent link; `mode` rides along so
          // the host knows whether the node's descendants come with it (see planInsertBetween).
          { kind: "insert-between", nodeId, edgeFrom: drop.from, edgeTo: drop.to, mode },
    );
  },
  onRepointDrop(ghostId, targetId) {
    // Task 15: repointAction (host) has no interactive prompt like mergeHeadsAction's
    // showInputBox, so its terminal "busy" post follows almost immediately — but arming the same
    // guard here anyway costs nothing (it's disarmed by repoint's busy:false moments later) and
    // keeps this callback's shape identical to onMergeDrop's rather than special-casing one drag
    // kind.
    post({ type: "repoint", ghostId, targetId, busyToken: armDropGuard() });
  },
  onDragMove(id, dxCanvas, dyCanvas) {
    updateDraggedEdges(id, dxCanvas, dyCanvas);
  },
  onDragActiveChange(active) {
    dragActive = active;
    // Task 19: dragging doesn't re-render the canvas (see dnd.ts's header comment), so an
    // already-applied ancestry highlight needs this explicit hook to tear down — otherwise it'd
    // sit there, stale, until the drag ends and something else happens to re-render. The edge
    // hover highlight (attachEdgeHover) needs the same treatment for a sharper reason: once the
    // drag takes pointer capture, `pointerout` for the edge under the cursor is retargeted to the
    // capturing card and never fires, so a highlight applied just before the drag began would have
    // nothing left to clear it.
    if (active) {
      clearActiveHover();
      clearEdgeHover();
    }
    if (!active) {
      // A full "state" push (if one arrived mid-drag) wins over a bare pending re-render request —
      // applyState's own renderStore() call at the end already covers whatever the pending render
      // was for, so there's nothing left for the `pendingRender` branch to do but clear itself.
      if (pendingState !== null) {
        const next = pendingState;
        pendingState = null;
        pendingRender = false;
        applyState(next);
      } else if (pendingRender) {
        pendingRender = false;
        renderStore();
      }
      // Deferred scroll (selectNode's side effect) always runs AFTER whichever render just
      // happened above (or would have been a no-op if neither branch rendered — renderStore()
      // itself no-ops without store.state, and scrollNodeIntoView guards the same way).
      if (pendingScrollId !== null) {
        const id = pendingScrollId;
        pendingScrollId = null;
        scrollNodeIntoView(id);
      }
    }
  },
};

/**
 * The render-only counterpart to `pendingState`: routes a re-render request through the same
 * dragActive-aware deferral, for message handlers that mutate the store but don't carry a fresh
 * AppState to stash (busy/detail/selectNode/busyReset, below). Their store mutations (store.detail,
 * store.busyOps, store.selectedId, ...) still happen immediately, synchronously, right before this
 * is called — only the DOM rebuild waits. While a drag is in flight this only flips
 * `pendingRender`; `dndCallbacks.onDragActiveChange(false)` flushes it with a plain `renderStore()`
 * once the drag ends.
 */
function requestRender(): void {
  if (dragActive) {
    pendingRender = true;
    return;
  }
  renderStore();
}

renderWaiting();

onMessage((msg) => {
  switch (msg.type) {
    case "state": {
      // Re-render guard (Task 14): a mid-drag DOM rebuild would orphan the card currently holding
      // pointer capture — stash and apply once the drag ends (dndCallbacks.onDragActiveChange).
      if (dragActive) {
        pendingState = msg.state;
        break;
      }
      applyState(msg.state);
      break;
    }
    case "detail":
      // Guard against a stale response for a selection the user has since moved on from.
      // `forId` names the id the response answers (null for a deselect), so one symmetric rule
      // covers both null and non-null: apply the message only if it still answers the current
      // selection. This matters even though VS Code's webview message channel is FIFO in both
      // directions and GraphPanelManager's "select" case has no async gap — a *later* select can
      // still be posted before an *earlier* select's response is handled, and without checking
      // `forId` a stale null response could wipe out a valid, newer detail (or vice versa).
      if (msg.forId === store.selectedId) {
        store.detail = msg.detail;
        requestRender();
      }
      break;
    case "toast":
      // Deliberately does NOT touch the drop guard (Task 16): an unrelated operation's toast
      // (e.g. an upgrade finishing) arriving inside the drop→busy window must not reopen the
      // double-drop race. The guard clears only on merge/repoint busy:false — see the "busy"
      // case below and dropGuardActive's doc comment.
      showToast(msg.level, msg.text);
      break;
    case "selectNode": {
      // Task 12: a click in the sidebar heads list routes here via GraphPanelManager.
      // revealAndSelect().
      selectAndCenterNode(msg.id);
      break;
    }
    case "busy": {
      // Drop-guard clearing is scoped (Task 16) to the arming drop's OWN terminal busy:false,
      // matched by the echoed token — the definitive "that drop's host-side transaction is over"
      // signal. While a merge/repoint/topology edit is actually running, busy:true keeps drags gated
      // via store.busyOps anyway, so not clearing on it loses nothing; an unrelated op's busy
      // traffic (upgrade/sql/..., another invocation's merge, a stale project's merge) must leave
      // the guard alone entirely — see dropGuardActive's doc comment. `"topology"` (the
      // freeform-topology task) is here for exactly the same reason merge is: topologyEditAction
      // broadcasts a terminal busy:false on every abort path (rejected plan, dismissed modal) with
      // no busy:true before it, and without this the guard would sit armed for its full 30s timeout
      // after any rejected freeform drop.
      if (
        !msg.active &&
        msg.token === armedDropToken &&
        (msg.operation === "merge" || msg.operation === "repoint" || msg.operation === "topology")
      ) {
        clearDropGuard();
      }
      // Tracked by per-invocation token, not operation name — see applyBusyMessage's doc comment.
      applyBusyMessage(store.busyOps, msg);
      // Task 17: an open context menu must not outlive the busy gate coming down — its items
      // would post actions the isEnabled() check at open time could no longer veto.
      if (msg.active) closeContextMenu();
      requestRender();
      break;
    }
    case "busyReset":
      // Belt-and-braces (project-switch review fix), primarily for the sidebar's persistent
      // busyOps Set — see protocol/messages.ts's doc comment. This webview's own panel is always
      // disposed/recreated on a project switch (GraphPanelManager's dispose() closes the actual
      // WebviewPanel), so `store.busyOps` starts fresh every time regardless; handled here anyway
      // for symmetry/defense-in-depth in case this instance is ever still alive when it arrives.
      store.busyOps.clear();
      clearDropGuard();
      requestRender();
      break;
    default:
      break;
  }
});

post({
  type: "ready",
  restored: persisted ? restoredPrefs(persisted) : null,
});

function renderWaiting(): void {
  app.replaceChildren();
  const waiting = document.createElement("p");
  waiting.textContent = "waiting for data…";
  app.append(waiting);
}

/** Applies a freshly-received (or drag-end-flushed) AppState: the one-time restored-selection
 * reconciliation, then a render. Split out of the "state" onMessage case so both the live
 * round-trip and the deferred-render flush (dndCallbacks.onDragActiveChange) share the exact same
 * logic. */
function applyState(state: AppState): void {
  const isFirstState = !firstStateHandled;
  firstStateHandled = true;
  store.state = state;

  // Task 17: a state push can move/remove the card an open context menu was opened on — dismiss
  // it (the brief's "dismiss on state re-render"). Scoped here rather than renderStore(): the
  // re-renders renderStore() performs for detail arrivals (including the one the menu's own
  // right-click-select triggers) must NOT dismiss — see closeContextMenu's doc comment.
  closeContextMenu();

  // One-time restore reconciliation: only meaningful the first time we have a real layout to
  // check the persisted selectedId against.
  if (isFirstState && persisted && store.selectedId !== null) {
    const stillExists = state.layout.nodes.some((n) => n.id === store.selectedId);
    if (stillExists) {
      // Highlight applies for free (renderStore() below reads store.selectedId); refetch its
      // detail since the previous webview instance's fetched detail didn't survive.
      post({ type: "select", id: store.selectedId });
    } else {
      store.selectedId = null;
      store.detailOpen = false;
    }
  }

  renderStore();
}

/** Re-renders from the current store, preserving the canvas scroll position across the rebuild
 * (render() replaces the canvas DOM wholesale on every call) — falling back to the last known
 * (possibly restored) scroll when there's no existing viewport yet, i.e. on the very first
 * render. Persists the full UI-prefs/selection/detail/scroll snapshot after every render, which
 * covers order/density/expandCollapsed (mirrored from state.ui), selection, and detailOpen —
 * every change funnels through here except scroll-only movement (see attachScrollListener).
 *
 * `scrollOverride` (Task 19) lets a zoom change (wheel, toolbar buttons, Fit) apply a freshly
 * computed anchor/fit-centered scroll instead of the default "preserve whatever's on screen right
 * now" behavior — those raw scrollTop/Left pixels mean a different content position once the
 * canvas' scale has changed, so blindly reapplying them would visibly jump the view.
 *
 * Never called directly while `dragActive` from any of the message handlers in `onMessage` below
 * — render() rebuilds the canvas wholesale, which would orphan the card currently holding pointer
 * capture mid-drag (see the `dragActive` doc comment above). The "state" case routes through
 * `applyState`, which stashes into `pendingState` while dragging instead of calling this; every
 * other handler that needs a render (busy, detail, selectNode, busyReset) routes through
 * `requestRender()`, which does the same via `pendingRender`. Both are flushed by
 * `dndCallbacks.onDragActiveChange(false)` the instant the drag ends. (Final-review fix: before
 * this, busy/detail/selectNode/busyReset called this function directly, unconditionally — this
 * comment's claim used to be false for exactly those four.) */
function renderStore(scrollOverride?: ScrollPoint): void {
  if (!store.state) return;
  const viewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  const scrollTop = scrollOverride?.scrollTop ?? viewport?.scrollTop ?? lastScroll.scrollTop;
  const scrollLeft = scrollOverride?.scrollLeft ?? viewport?.scrollLeft ?? lastScroll.scrollLeft;

  // FLIP (Task 19, flip.ts): snapshot the OLD canvas' node positions before render() replaces it.
  // `viewport === null` (no previous canvas at all, e.g. the very first render) is the "nothing to
  // animate from" case both captureFlipSnapshot and playFlip/playEdgesFade already treat as a
  // no-op via their own null/hasPrevious checks.
  const flipSnapshot = captureFlipSnapshot(viewport);
  const hadPreviousCanvas = viewport !== null;

  // Task 19: preserve keyboard focus across the rebuild too, same idea as scroll above. Without
  // this, ANY re-render while a card is keyboard-focused (not just keyboard nav's own — e.g. the
  // "detail" response that follows a couple ms after every select, click or keyboard alike) drops
  // focus back to nothing, silently breaking the very next arrow-key press (keyboardNav.ts only
  // acts "when a card has focus"). navigateToNode's own explicit .focus() call on the NEW target
  // still wins for the arrow-key-move render itself; this is what keeps it sticky through whatever
  // re-render happens after.
  const focusedNodeId = document.activeElement?.closest<HTMLElement>(".alx-card[data-node-id]")?.dataset.nodeId;

  const view: ViewState = {
    selectedId: store.selectedId,
    detail: store.detail,
    detailOpen: store.detailOpen,
    busy: store.busyOps.size > 0,
    zoom: store.zoom,
    search: store.search,
  };
  render(app, store.state, view, handlers);

  const nextViewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  const toolbarEl = document.querySelector<HTMLElement>(".alx-toolbar");
  if (nextViewport) {
    nextViewport.scrollTop = scrollTop;
    nextViewport.scrollLeft = scrollLeft;
    lastScroll = { scrollTop, scrollLeft };
    attachScrollListener(nextViewport);
    // dnd.ts (Task 14): re-attach every render since the viewport (and every card in it) is a
    // fresh DOM subtree each time — same reason attachScrollListener above is re-run.
    attachDnd(nextViewport, store.state, store.zoom, dndCallbacks);
    // contextMenu.ts (Task 17): same re-attach-every-render reasoning; reuses the exact same
    // busy/drop-guard gate a drag start checks (dndCallbacks.isEnabled), PLUS !dragActive: a
    // right-click while a left-button drag is mid-flight must not open a menu — its select side
    // effect re-renders the canvas, which would orphan the card currently holding pointer
    // capture (the very thing the "state"-message deferral protects against).
    // The edit-mode lock is passed as a SEPARATE predicate rather than folded into the
    // `isEnabled()` gate above, because that gate covers the WHOLE menu: the lock must suppress
    // only the edge menu ("Remove link" is a mutating gesture-reached edit), never a revision
    // card's menu, whose items are all labeled commands the lock deliberately leaves live — and
    // since locked is the default, folding it in would mean the graph normally opens with no card
    // menu at all.
    attachContextMenu(nextViewport, () => dndCallbacks.isEnabled() && !dragActive, () => !isEditLocked(), menuHandlers);
    // Task 19: same re-attach-every-render pattern for zoom/hover/keyboard nav — and, since the
    // freeform-topology task, for the edge hover highlight.
    attachZoomWheel(nextViewport);
    attachHover(nextViewport, store.state.layout, hoverCallbacks);
    attachEdgeHover(nextViewport);
    attachKeyboardNav(nextViewport, navNodes(store.state), store.state.ui.order, store.state.ui.axis, keyboardHandlers);
    if (toolbarEl) {
      attachSearch(toolbarEl, nextViewport, searchableCards(store.state), store.search.query, store.search.index, searchCallbacks);
    }
    playFlip(nextViewport, flipSnapshot);
    playEdgesFade(nextViewport, hadPreviousCanvas);

    if (focusedNodeId !== undefined) {
      nextViewport.querySelector<HTMLElement>(`.alx-card[data-node-id="${CSS.escape(focusedNodeId)}"]`)?.focus({ preventScroll: true });
    }
  }

  persist();
}

/** Jump selection to `id` and center it: the shared path behind the host's "selectNode" message
 * (sidebar heads / CodeLens, Task 12) and the detail panel's clickable down_revision links — same
 * selection side effects as clicking the card directly (onSelect), plus centering the canvas on
 * the node since it may be scrolled out of view. Dismisses any open context menu first — selection
 * just moved somewhere else entirely (and the centering scroll may be a no-op, so the menu's own
 * scroll-dismiss listener can't be relied on to fire). For an id hidden inside the collapse node
 * the scroll/highlight are no-ops but the detail fetch still works (getDetail reads the graph, not
 * the layout). Distinct from `navigateToNode` (Task 19's keyboard/search jump), which renders
 * synchronously via onSelect and moves keyboard FOCUS to the card — this one is drag-safe
 * (deferred render/scroll) and focus-neutral, matching what a host-initiated jump needs. */
function selectAndCenterNode(id: string): void {
  closeContextMenu();
  store.selectedId = id;
  store.detail = null;
  store.detailOpen = true;
  post({ type: "select", id });
  requestRender();
  // Deferred the same way the render itself is (final-review fix): scrollNodeIntoView reads
  // the just-rendered canvas' layout, so jumping the (still mid-drag, about-to-be-orphaned)
  // OLD viewport here would be pointless at best — stash the id and let
  // `onDragActiveChange(false)` run it right after the deferred render actually applies.
  if (dragActive) {
    pendingScrollId = id;
  } else {
    scrollNodeIntoView(id);
  }
}

/** Scrolls the canvas viewport so `id`'s card is roughly centered — used by `selectAndCenterNode`
 * (Task 12) and `navigateToNode` (Task 19) to bring a just-selected node into view. Computes the target position from
 * the pure metrics.ts math (the same formulas render.ts's computePositions uses) rather than
 * querying the just-rendered DOM node's offset, so it works even for a node whose wrapper doesn't
 * expose its own position lookup. Must run AFTER renderStore() so `.alx-canvas-viewport` reflects
 * the current node/order/density layout and has a settled clientWidth/clientHeight to center
 * within. A no-op if `id` isn't a real layout node (e.g. a stale/unknown id) or the viewport isn't
 * in the DOM (state not yet rendered). */
function scrollNodeIntoView(id: string): void {
  if (!store.state) return;
  const node = store.state.layout.nodes.find((n) => n.id === id);
  const viewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  if (!node || !viewport) return;

  const { ui, layout } = store.state;
  const { x, y } = nodeXY(node, ui, layout.rowCount, ui.density);
  const { w, h } = nodeSize(node, ui.density);
  const scrollLeft = Math.max(0, x + w / 2 - viewport.clientWidth / 2);
  const scrollTop = Math.max(0, y + h / 2 - viewport.clientHeight / 2);

  viewport.scrollTo({ left: scrollLeft, top: scrollTop });
  lastScroll = { scrollTop, scrollLeft };
  persist();
}

let scrollPersistTimer: ReturnType<typeof setTimeout> | null = null;

/** Attaches a throttled (~250ms trailing) scroll listener to `viewport`. Scroll events don't
 * bubble, and the canvas (including the viewport element) is rebuilt wholesale on every render, so
 * this must be re-attached to the fresh element after every renderStore() call. Per the brief:
 * scrolling must NOT trigger a re-render — this only updates `lastScroll` + persists.
 *
 * The scheduled flush deliberately re-queries `.alx-canvas-viewport` from the document instead of
 * reading `viewport` (the parameter) at fire time: `scrollPersistTimer` is a single module-level
 * guard shared across every attachScrollListener() call, so a scroll event on an OLDER viewport
 * can still be the one that wins the "already scheduled" race and be the one whose timeout fires —
 * by which point a re-render may have replaced it in the DOM. A detached element's scrollTop is
 * not reliably its last live value (observed empirically: it reads back as 0), so closing over the
 * stale element and reading it 250ms later can silently persist a wrong scroll position. */
function attachScrollListener(viewport: HTMLElement): void {
  viewport.addEventListener("scroll", () => {
    if (scrollPersistTimer !== null) return; // a flush is already scheduled; it'll read the latest position
    scrollPersistTimer = setTimeout(() => {
      scrollPersistTimer = null;
      const current = document.querySelector<HTMLElement>(".alx-canvas-viewport");
      if (!current) return;
      lastScroll = { scrollTop: current.scrollTop, scrollLeft: current.scrollLeft };
      persist();
    }, 250);
  });
}

/** Writes the full persisted-state shape to `vscode.setState`, composed from the current store +
 * host-authoritative ui (from the last "state" message, if any) + last known scroll. */
function persist(): void {
  const ui = store.state?.ui;
  const snapshot: PersistedUiState = {
    order: ui?.order,
    density: ui?.density,
    expandCollapsed: ui?.expandCollapsed,
    axis: ui?.axis,
    editLocked: ui?.editLocked,
    selectedId: store.selectedId,
    detailOpen: store.detailOpen,
    scrollTop: lastScroll.scrollTop,
    scrollLeft: lastScroll.scrollLeft,
    zoom: store.zoom,
  };
  setPersisted(snapshot);
}

/** Narrows a persisted snapshot down to the `Partial<UiPrefs>` the `ready` handshake sends —
 * omitting (not just leaving `undefined`) any field the snapshot never populated, since spreading
 * an object with an explicit `undefined` value would otherwise clobber the host's corresponding
 * field in `applyUiPrefs`'s `{...base, ...prefs}` merge. */
function restoredPrefs(p: PersistedUiState): Partial<UiPrefs> {
  const out: Partial<UiPrefs> = {};
  if (p.order !== undefined) out.order = p.order;
  if (p.density !== undefined) out.density = p.density;
  if (p.expandCollapsed !== undefined) out.expandCollapsed = p.expandCollapsed;
  if (p.axis !== undefined) out.axis = p.axis;
  if (p.editLocked !== undefined) out.editLocked = p.editLocked;
  return out;
}
