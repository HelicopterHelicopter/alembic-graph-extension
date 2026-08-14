/**
 * Migration graph canvas — DOM construction only (createElement/textContent/setAttribute; never
 * innerHTML with state data, since messages/hashes/branch labels/file paths all come straight
 * from files in the user's workspace). Faithful port of the design file's `renderVals()` (see
 * `design/Alembic Graph.dc.html`), adapted to real `AppState`/`LayoutNode` shapes and the theme
 * token layer in graph.css. Per the brief, only position/size/lane-color/z-index are dynamic
 * inline styles — every other visual rule lives in a graph.css class.
 */
import type { GraphLayout, LayoutNode } from "../../core/types";
import type { AppState, GhostBlame, RevisionDetail, UiPrefs } from "../../protocol/messages";
import { buildBadgeItems } from "./badges";
import { buildDetailPanel, type DetailHandlers } from "./detail";
import { canvasSize, edgePathD, nodeSize, nodeXY, type Density } from "./metrics";
import { ghostBlameLineText } from "./uxMath";

export interface ViewState {
  selectedId: string | null;
  /** Last detail payload the host sent for the current selection; null while unknown/loading or
   * when the selected id has no detail (ghost/collapse). */
  detail: RevisionDetail | null;
  /** Whether the panel should be shown at all — independent of `detail`, so closing it (✕) keeps
   * the card selection/highlight while hiding the panel (matches the design's `closeDetails`). */
  detailOpen: boolean;
  /** True while `store.busyOps` (main.ts) is non-empty — any host-side action (merge, later
   * upgrade/downgrade/...) is in flight. Drives the toolbar's busy indicator; drag gating itself
   * lives in dnd.ts's `isEnabled()` callback, not here. */
  busy: boolean;
  /** Task 19: canvas scale factor [0.5, 1.5] — applied as `transform: scale()` on `.alx-canvas`
   * (see `buildCanvasViewport`). Webview-local state (main.ts's store), never sent to the host. */
  zoom: number;
  /** Task 19: current search box contents + cycle position — only consulted here to seed the
   * `<input>`'s initial `.value` (so a host-driven re-render doesn't blank an in-progress query)
   * and the `N of M` count's starting point; live filtering/cycling is search.ts's job, wired
   * post-render (see its header comment for why it can't go through a `render()` call). */
  search: { query: string; index: number };
}

export interface Handlers {
  onSelect(id: string): void;
  onToggleOrder(order: UiPrefs["order"]): void;
  onToggleDensity(density: UiPrefs["density"]): void;
  /** Task H: toolbar Axis toggle (Horizontal | Vertical), left of Order. */
  onToggleAxis(axis: UiPrefs["axis"]): void;
  onExpandCollapse(): void;
  onCloseDetail(): void;
  onOpenFile(id: string): void;
  /** Detail panel's clickable down_revision ids — jump selection to that parent revision. */
  onNavigateToRevision(id: string): void;
  /** Task 17: toolbar "+ New revision" button — `showInputBox`/QuickPick flow lives host-side
   * (newRevisionAction), this just posts the request. */
  onNewRevision(): void;
  /** Task 19: toolbar zoom cluster (−/100%/+/Fit), right of "+ New revision". */
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  onZoomFit(): void;
  /** Task 20: toolbar "Export SVG" — builds the standalone SVG string (svgExport.ts) from the
   * CURRENT store and posts it to the host for a save-dialog write. Building the string is main.ts's
   * job (it owns `store`), not render.ts's — this handler is a plain, parameterless trigger like
   * `onNewRevision`. */
  onExportSvg(): void;
  /** Task B2: ghost card's inline Restore/Import button. `ghostId` is the ghost node's own id
   * (the missing revision id, and the key `state.ghostBlame` is indexed by) — main.ts posts
   * `{type:"restoreFile", ghostId}`, gated the same busy-guard way as `onNewRevision`/`onExportSvg`. */
  onRestoreFile(ghostId: string): void;
  /** N-way task: the merge-hint banner's inline "Merge all N heads" button, shown only once there
   * are 3+ current heads (with exactly 2, the banner stays drag-hint-only, same as before this
   * task). `ids` is every current head id, in `state.heads` order — main.ts arms the drop guard
   * (mirroring a drag-merge drop) and posts `{type:"merge", ids}`, gated the same busy-guard way
   * as `onNewRevision`/`onExportSvg`/`onRestoreFile`. */
  onMergeAllHeads(ids: string[]): void;
}

interface Pos {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Renders the full graph canvas into `root`, replacing its previous contents. */
export function render(root: HTMLElement, state: AppState, view: ViewState, handlers: Handlers): void {
  root.className = "alx-root";
  const toastLayer = ensureToastLayer(root);

  if (state.project === null) {
    const empty = document.createElement("div");
    empty.className = "alx-empty";
    empty.textContent = "No Alembic project found in this workspace.";
    root.replaceChildren(empty, toastLayer);
    return;
  }

  const positions = computePositions(state);
  const toolbar = buildToolbar(state, view, handlers);
  const canvasViewport = buildCanvasViewport(state, view, handlers, positions);

  const canvasRow = document.createElement("div");
  canvasRow.className = "alx-canvas-row";
  canvasRow.append(canvasViewport);

  if (view.detailOpen && view.detail !== null) {
    const detailHandlers: DetailHandlers = {
      onClose: handlers.onCloseDetail,
      onOpenFile: handlers.onOpenFile,
      onNavigateToRevision: handlers.onNavigateToRevision,
    };
    canvasRow.append(buildDetailPanel(view.detail, detailHandlers));
  }

  root.replaceChildren(toolbar, canvasRow, toastLayer);
}

// ---------- toast ----------

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Shows (or replaces) the single bottom-right toast; auto-dismisses after 3800ms. A no-op if
 * `render()` hasn't run yet (no toast layer to show it in). */
export function showToast(level: "info" | "success" | "error", text: string): void {
  const toast = document.querySelector<HTMLElement>(".alx-toast");
  if (!toast) return;
  if (toastTimer !== null) clearTimeout(toastTimer);

  toast.textContent = text;
  toast.className = `alx-toast alx-toast--visible alx-toast--${level}`;

  toastTimer = setTimeout(() => {
    toastTimer = null;
    toast.classList.remove("alx-toast--visible");
  }, 3800);
}

/** Finds the persistent toast element (surviving re-renders) or creates it. Never destroyed by
 * `render()` — only re-appended — so an in-flight toast + its dismiss timer survive a live state
 * update arriving while it's showing. */
function ensureToastLayer(root: HTMLElement): HTMLElement {
  const existing = root.querySelector<HTMLElement>(":scope > .alx-toast");
  if (existing) return existing;
  const toast = document.createElement("div");
  toast.className = "alx-toast";
  return toast;
}

// ---------- toolbar ----------

function buildToolbar(state: AppState, view: ViewState, handlers: Handlers): HTMLElement {
  const busy = view.busy;
  const toolbar = document.createElement("div");
  toolbar.className = "alx-toolbar";

  const label = document.createElement("div");
  label.className = "alx-project-label";
  label.textContent = state.project!.label;

  const sep = document.createElement("div");
  sep.className = "alx-sep";

  const headsChip = document.createElement("div");
  headsChip.className = "alx-heads-chip";
  const headsDot = document.createElement("span");
  headsDot.className = "alx-heads-dot";
  const headsText = document.createElement("span");
  headsText.textContent = `${state.counts.heads} heads`;
  headsChip.append(headsDot, headsText);

  const revCount = document.createElement("div");
  revCount.className = "alx-rev-count";
  revCount.textContent = `${state.counts.revisions} revisions`;

  const spacer = document.createElement("div");
  spacer.className = "alx-spacer";

  const busyIndicator = buildBusyIndicator(busy);

  // Task 19: search box, left of "Order". Live filtering/cycling is wired post-render by
  // search.ts (see its header comment) — this just builds the bare input/count elements it looks
  // for, seeded from the last known query so a host-driven re-render doesn't blank it.
  const searchWrap = document.createElement("div");
  searchWrap.className = "alx-search-wrap";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "alx-search-input";
  searchInput.placeholder = "Search revisions…";
  searchInput.value = view.search.query;
  searchInput.spellcheck = false;
  const searchCount = document.createElement("span");
  searchCount.className = "alx-search-count";
  searchWrap.append(searchInput, searchCount);

  // Task H: Axis toggle, left of Order — Horizontal (default, root left / heads right) vs
  // Vertical (the original top-to-bottom layout).
  const axisLabel = document.createElement("span");
  axisLabel.className = "alx-order-label";
  axisLabel.textContent = "Axis";

  const axisGroup = document.createElement("div");
  axisGroup.className = "alx-toggle-group";
  axisGroup.append(
    makeToggle("Horizontal", state.ui.axis === "horizontal", () => handlers.onToggleAxis("horizontal")),
    makeToggle("Vertical", state.ui.axis === "vertical", () => handlers.onToggleAxis("vertical")),
  );

  const orderLabel = document.createElement("span");
  orderLabel.className = "alx-order-label";
  orderLabel.textContent = "Order";

  // Task H: labels adapt per axis — horizontal reads as a left/right direction (the newest end is
  // now on a side, not top/bottom), vertical keeps the original up/down arrows.
  const newestBottomLabel = state.ui.axis === "horizontal" ? "Newest →" : "Newest ↓";
  const newestTopLabel = state.ui.axis === "horizontal" ? "Newest ←" : "Newest ↑";
  const orderGroup = document.createElement("div");
  orderGroup.className = "alx-toggle-group";
  orderGroup.append(
    makeToggle(newestBottomLabel, state.ui.order === "newest-bottom", () => handlers.onToggleOrder("newest-bottom")),
    makeToggle(newestTopLabel, state.ui.order === "newest-top", () => handlers.onToggleOrder("newest-top")),
  );

  const densityGroup = document.createElement("div");
  densityGroup.className = "alx-toggle-group";
  densityGroup.append(
    makeToggle("Comfortable", state.ui.density === "comfortable", () => handlers.onToggleDensity("comfortable")),
    makeToggle("Compact", state.ui.density === "compact", () => handlers.onToggleDensity("compact")),
  );

  // Task 17: right of the density toggles, design's plain (never active-colored) toggleBtn style
  // — disabled (dim, pointer-events:none, same convention as the sidebar's footer button) while
  // any host-side operation is in flight.
  const newRevisionBtn = document.createElement("div");
  newRevisionBtn.className = busy ? "alx-toggle alx-toggle--disabled" : "alx-toggle";
  newRevisionBtn.textContent = "+ New revision";
  newRevisionBtn.addEventListener("click", () => handlers.onNewRevision());

  const zoomCluster = buildZoomCluster(view.zoom, handlers);

  // Task 20: right of the zoom cluster, same busy-disabled toggleBtn convention as "+ New
  // revision" above — exporting mid-operation risks nothing correctness-wise (it's a pure read of
  // the current store), but the disabled styling keeps every toolbar action consistently gated
  // while something else is in flight, matching the brief.
  const exportSvgBtn = document.createElement("div");
  exportSvgBtn.className = busy ? "alx-toggle alx-toggle--disabled" : "alx-toggle";
  exportSvgBtn.textContent = "Export SVG";
  exportSvgBtn.addEventListener("click", () => handlers.onExportSvg());

  toolbar.append(label, sep, headsChip, revCount, spacer);
  if (busyIndicator) toolbar.append(busyIndicator);
  toolbar.append(
    searchWrap,
    axisLabel,
    axisGroup,
    orderLabel,
    orderGroup,
    densityGroup,
    newRevisionBtn,
    zoomCluster,
    exportSvgBtn,
  );
  return toolbar;
}

/** Task 19: `−` / `100%`(current zoom%, click resets to 1.0) / `+` / `Fit`, right of "+ New
 * revision". */
function buildZoomCluster(zoom: number, handlers: Handlers): HTMLElement {
  const cluster = document.createElement("div");
  cluster.className = "alx-zoom-cluster";

  const zoomOut = document.createElement("div");
  zoomOut.className = "alx-zoom-btn";
  zoomOut.textContent = "−";
  zoomOut.title = "Zoom out";
  zoomOut.addEventListener("click", () => handlers.onZoomOut());

  const reset = document.createElement("div");
  reset.className = "alx-zoom-btn alx-zoom-pct";
  reset.textContent = `${Math.round(zoom * 100)}%`;
  reset.title = "Reset zoom to 100%";
  reset.addEventListener("click", () => handlers.onZoomReset());

  const zoomIn = document.createElement("div");
  zoomIn.className = "alx-zoom-btn";
  zoomIn.textContent = "+";
  zoomIn.title = "Zoom in";
  zoomIn.addEventListener("click", () => handlers.onZoomIn());

  const fit = document.createElement("div");
  fit.className = "alx-zoom-btn";
  fit.textContent = "Fit";
  fit.title = "Fit whole graph in view";
  fit.addEventListener("click", () => handlers.onZoomFit());

  cluster.append(zoomOut, reset, zoomIn, fit);
  return cluster;
}

/** Subtle "an action is running" indicator (Task 14: shown while `store.busyOps` — main.ts — is
 * non-empty, e.g. a drag-to-merge drop is running `alembic merge`). Returns null when not busy so
 * callers can skip appending it entirely rather than appending an empty/hidden element. */
function buildBusyIndicator(busy: boolean): HTMLElement | null {
  if (!busy) return null;
  const wrap = document.createElement("div");
  wrap.className = "alx-busy-indicator";

  const spinner = document.createElement("span");
  spinner.className = "alx-busy-spinner";
  spinner.textContent = "⟳";

  const label = document.createElement("span");
  label.textContent = "working…";

  wrap.append(spinner, label);
  return wrap;
}

function makeToggle(text: string, active: boolean, onClick: () => void): HTMLElement {
  const btn = document.createElement("div");
  btn.className = active ? "alx-toggle alx-toggle--active" : "alx-toggle";
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------- canvas ----------

function computePositions(state: AppState): Map<string, Pos> {
  const { layout, ui } = state;
  const density = ui.density;
  const map = new Map<string, Pos>();
  for (const node of layout.nodes) {
    const { x, y } = nodeXY(node, ui, layout.rowCount, density);
    const { w, h } = nodeSize(node, density);
    map.set(node.id, {
      x,
      y,
      w,
      h,
      cx: x + w / 2,
      cy: y + h / 2,
      top: y,
      bottom: y + h,
      left: x,
      right: x + w,
    });
  }
  return map;
}

function buildCanvasViewport(
  state: AppState,
  view: ViewState,
  handlers: Handlers,
  positions: Map<string, Pos>,
): HTMLElement {
  const { layout, ui } = state;
  const density = ui.density;
  const size = canvasSize(layout, ui, density);
  const zoom = view.zoom;

  const viewport = document.createElement("div");
  viewport.className = "alx-canvas-viewport";

  // Task 19 (zoom): `scaleWrapper` is what actually determines the viewport's scrollable extent
  // (its own box is sized to canvasSize * zoom) — `canvas` keeps its UNSCALED size and is visually
  // scaled via `transform`, so every descendant position (nodes, edges) stays in the same simple
  // pixel coordinate space metrics.ts already computes, at any zoom level.
  const scaleWrapper = document.createElement("div");
  scaleWrapper.className = "alx-canvas-scale";
  scaleWrapper.style.width = `${size.w * zoom}px`;
  scaleWrapper.style.height = `${size.h * zoom}px`;

  const canvas = document.createElement("div");
  canvas.className = "alx-canvas";
  canvas.style.width = `${size.w}px`;
  canvas.style.height = `${size.h}px`;
  canvas.style.transform = `scale(${zoom})`;

  canvas.append(buildEdgesSvg(layout, size, positions, state.laneColors, ui.axis));

  for (const node of layout.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    canvas.append(buildNodeElement(node, state, view, handlers, pos, density));
  }

  const mergeHint = buildMergeHint(state, view, positions, ui.axis, handlers, size);
  if (mergeHint) canvas.append(mergeHint);

  scaleWrapper.append(canvas);
  viewport.append(scaleWrapper);
  return viewport;
}

function buildEdgesSvg(
  layout: GraphLayout,
  size: { w: number; h: number },
  positions: Map<string, Pos>,
  laneColors: string[],
  axis: UiPrefs["axis"],
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", String(size.w));
  svg.setAttribute("height", String(size.h));
  svg.setAttribute("class", "alx-edges");

  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));

  for (const edge of layout.edges) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) continue;

    // Anchor = upper card's bottom-center -> lower card's top-center in vertical, lefter card's
    // right-center -> righter card's left-center in horizontal (metrics.ts's edgePathD, shared
    // with svgExport.ts so the standalone export draws identical curves).
    const d = edgePathD(a, b, axis);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    // Task 19: hover.ts reads these to decide whether an edge sits on the hovered ancestor path —
    // `edge.from`/`.to` are already the parent/child node ids (see LayoutEdge in core/types.ts).
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;

    const classes = ["alx-edge"];
    if (edge.kind === "broken") classes.push("alx-edge--broken");
    else if (edge.kind === "collapse") classes.push("alx-edge--collapse");
    const childApplied = nodeById.get(edge.to)?.applied;
    if (childApplied === false) classes.push("alx-edge--dim");
    path.setAttribute("class", classes.join(" "));

    // Lane color is the one per-edge dynamic value (runtime state.laneColors) -> inline style.
    if (edge.kind === "normal") {
      path.style.stroke = laneColors[edge.colorLane] ?? laneColors[0] ?? "#4aa3ff";
    }

    svg.append(path);

    // Freeform topology drag: an invisible, fat-stroked twin of every REAL parent link, appended
    // right after its visible path, purely so a pointer can hit-test a 2px curve (`.alx-edge-hit`
    // in graph.css opts back into pointer events against `.alx-edges { pointer-events: none }`).
    // `collapse` edges get no twin — a collapse edge stands for a folded run of links, not one
    // parent link, so it is never a drop target. `data-edge-kind` lets the drop handler tell a
    // broken (dangling) link from a normal one without re-deriving it from the layout.
    // The twin carries the SAME `data-from`/`data-to` as its visible path, so main.ts's
    // `updateDraggedEdges` (which selects by those attributes) re-paths both on every drag frame
    // and the hit area follows a live drag for free — deliberate, not an accident of the query.
    // hover.ts is unaffected: it selects `.alx-edge`, a class the twin does not carry.
    if (edge.kind !== "collapse") {
      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "alx-edge-hit");
      hit.dataset.from = edge.from;
      hit.dataset.to = edge.to;
      hit.dataset.edgeKind = edge.kind;
      svg.append(hit);
    }
  }

  return svg;
}

// ---------- node cards ----------

/**
 * Freeform-topology task: the broken-parent map that used to live here (child id -> the missing
 * parent id it revises, derived from `state.problems`) is gone along with its one consumer — a
 * broken NON-head revision card no longer carries `data-repoint-ghost-id`, because dragging ANY
 * revision card is now a freeform topology drag (see `buildRevisionCard`). Repointing a missing
 * parent is still reachable exactly where it always was conceptually: drag the ghost card itself,
 * which keeps its own `data-repoint-ghost-id` (see `buildGhostCard`) — or drag the broken child onto
 * the parent it should revise, which the freeform `move-*` path expresses directly.
 */
function buildNodeElement(
  node: LayoutNode,
  state: AppState,
  view: ViewState,
  handlers: Handlers,
  pos: Pos,
  density: Density,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "alx-node";
  // Task 19: FLIP (flip.ts) diffs `.alx-node[data-node-id]` positions across re-renders — set here
  // (not just on the card/ghost/collapse child) so it's uniform across all three node kinds.
  wrapper.dataset.nodeId = node.id;
  wrapper.style.left = `${pos.x}px`;
  wrapper.style.top = `${pos.y}px`;
  wrapper.style.width = `${pos.w}px`;
  wrapper.style.height = `${pos.h}px`;
  wrapper.style.zIndex = String(node.id === view.selectedId ? 25 : 6);

  if (node.kind === "ghost") {
    const ghost = buildGhostCard(node);
    // Per the design (onPointerDown on every node kind): a ghost is selectable — the host has no
    // graph node for it, so `select` resolves to a null detail and the panel simply stays hidden
    // (see ViewState.detail / render()'s `view.detail !== null` gate).
    ghost.addEventListener("click", () => handlers.onSelect(node.id));
    wrapper.append(ghost);

    // Task B2: blame line + Restore/Import button, keyed by this ghost's own id (the missing
    // revision id `state.ghostBlame` is indexed by). Absent key (search pending) or `null`
    // (searched-and-not-found) both render nothing — see buildGhostBlameLine.
    const blameLine = buildGhostBlameLine(node.id, state.ghostBlame[node.id], view.busy, handlers.onRestoreFile);
    if (blameLine) wrapper.append(blameLine);

    return wrapper;
  }
  if (node.kind === "collapse") {
    const collapse = buildCollapseCard(node, handlers);
    collapse.dataset.nodeId = node.id;
    wrapper.append(collapse);
    return wrapper;
  }

  const card = buildRevisionCard(node, view, density, state.laneColors);
  card.addEventListener("click", () => handlers.onSelect(node.id));
  wrapper.append(card);

  if (node.isBroken) {
    const hint = document.createElement("div");
    hint.className = "alx-broken-hint";
    hint.textContent = "⚠ down_revision missing — drag onto a parent to re-point";
    wrapper.append(hint);
  }

  return wrapper;
}

function buildGhostCard(node: LayoutNode): HTMLElement {
  const card = document.createElement("div");
  card.className = "alx-ghost";
  card.dataset.nodeId = node.id;
  // Task 15: a ghost is always a repoint-drag source — its own id IS the missing revision id
  // dnd.ts needs for the posted `{type:"repoint", ghostId, targetId}` message. See dnd.ts's
  // `[data-repoint-ghost-id]` selector.
  card.dataset.repointGhostId = node.id;

  const label = document.createElement("div");
  label.className = "alx-ghost-label";
  label.textContent = "⚠ missing revision";

  const hash = document.createElement("div");
  hash.className = "alx-ghost-hash";
  hash.textContent = node.hash;

  card.append(label, hash);
  return card;
}

/**
 * Task B2: the ghost card's blame line — same absolute `top: calc(100% + 4px)` placement pattern
 * as `.alx-broken-hint` (below the card, out of layout flow — keeps GHOST_H in metrics.ts
 * untouched). Returns null (renders nothing) when `blame` is `undefined` (search pending — the key
 * is absent from `state.ghostBlame`) or `null` (searched-and-not-found), per the spec: the ghost
 * card looks exactly as it did before Task B2 in both of those cases.
 *
 * The block itself is `pointer-events: none` (graph.css) except the button, which is `auto` — a
 * click on the text/whitespace must fall through to nothing (there's no card underneath this
 * block, just canvas), while the button is independently busy-gated the same
 * dim/no-pointer/pointer-events:none convention as every other toolbar affordance
 * (`.alx-toggle--disabled`), via a dedicated `.alx-ghost-restore-btn--disabled` class.
 */
function buildGhostBlameLine(
  ghostId: string,
  blame: GhostBlame | null | undefined,
  busy: boolean,
  onRestoreFile: (ghostId: string) => void,
): HTMLElement | null {
  if (!blame) return null;

  const { text, button, tooltip } = ghostBlameLineText(blame);

  const line = document.createElement("div");
  line.className = "alx-ghost-blame";
  line.title = tooltip;

  const label = document.createElement("span");
  label.className = "alx-ghost-blame-text";
  label.textContent = text;
  line.append(label);

  if (button !== null) {
    const btn = document.createElement("span");
    btn.className = busy ? "alx-ghost-restore-btn alx-ghost-restore-btn--disabled" : "alx-ghost-restore-btn";
    btn.textContent = button;
    btn.addEventListener("click", () => {
      if (busy) return; // belt-and-suspenders with the --disabled class's pointer-events:none
      onRestoreFile(ghostId);
    });
    line.append(btn);
  }

  return line;
}

function buildCollapseCard(node: LayoutNode, handlers: Handlers): HTMLElement {
  const card = document.createElement("div");
  card.className = "alx-collapse";
  card.textContent = `⋮   ${node.collapsedCount ?? 0} earlier revisions`;
  card.addEventListener("click", () => handlers.onExpandCollapse());
  return card;
}

function buildRevisionCard(
  node: LayoutNode,
  view: ViewState,
  density: Density,
  laneColors: string[],
): HTMLElement {
  const selected = node.id === view.selectedId;
  const laneColor = laneColors[node.lane] ?? laneColors[0] ?? "#4aa3ff";

  const card = document.createElement("div");
  card.className = [
    "alx-card",
    density === "compact" ? "alx-card--compact" : null,
    selected ? "alx-card--selected" : null,
    // Freeform-topology task: EVERY revision card is now a drag source (dnd.ts's `"freeform"`
    // kind) — dragging one re-parents it onto whatever card/link it's dropped on, so the grab
    // cursor + `touch-action: none` this class carries (see graph.css) belong on all of them, not
    // just the heads/broken subset that could drag before. Ghost cards keep their own equivalent
    // styling (`.alx-ghost`) and collapse cards stay undraggable.
    "alx-card--draggable",
  ]
    .filter((c): c is string => c !== null)
    .join(" ");
  // dnd.ts event-delegates off `data-node-id` (set on every revision card here, and on ghost/
  // collapse cards above for hit-testing reuse) — that attribute alone now identifies a freeform
  // drag source. `data-head` marks the head subset for the rest of the UI (and keeps the DOM
  // self-describing); the drag machine reads head-ness from `AppState.heads` instead, and
  // `data-repoint-ghost-id` is now set ONLY on ghost cards (see buildGhostCard).
  card.dataset.nodeId = node.id;
  if (node.isHead) card.dataset.head = "true";

  // Task 19: keyboard navigation (keyboardNav.ts) — only revision cards are focusable (ghost/
  // collapse cards keep their plain click-only affordance; see the brief's "Cards" scoping).
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", buildAriaLabel(node));

  const stripe = document.createElement("div");
  stripe.className = node.applied === false ? "alx-stripe alx-stripe--dim" : "alx-stripe";
  stripe.style.background = laneColor; // lane color: the one dynamic value here -> inline style

  const head = document.createElement("div");
  head.className = "alx-card-head";

  const dot = document.createElement("div");
  dot.className = [
    "alx-dot",
    node.applied === true ? "alx-dot--applied" : null,
    node.isCurrent ? "alx-dot--current" : null,
  ]
    .filter((c): c is string => c !== null)
    .join(" ");

  const hash = document.createElement("div");
  hash.className = node.applied === true ? "alx-hash alx-hash--applied" : "alx-hash";
  hash.textContent = node.hash;

  const headSpacer = document.createElement("div");
  headSpacer.className = "alx-spacer";

  head.append(dot, hash, headSpacer);
  const badges = buildBadges(node);
  if (badges) head.append(badges);

  const message = document.createElement("div");
  message.className = [
    "alx-message",
    density === "compact" ? "alx-message--compact" : null,
    node.applied === true ? "alx-message--applied" : null,
  ]
    .filter((c): c is string => c !== null)
    .join(" ");
  message.textContent = node.message;

  const metaRow = document.createElement("div");
  metaRow.className = "alx-meta-row";
  if (node.branchLabel !== null) {
    const tag = document.createElement("div");
    tag.className = "alx-badge alx-badge--tag";
    tag.style.color = laneColor;
    tag.style.borderColor = laneColor;
    tag.textContent = node.branchLabel;
    metaRow.append(tag);
  }
  const meta = document.createElement("div");
  meta.className = "alx-meta";
  meta.textContent = metaText(node);
  metaRow.append(meta);

  card.append(stripe, head, message, metaRow);
  return card;
}

/** Task 19: `<hash8> — <message>, <badges>` (e.g. "3aebf188 — add rate limiting, head") — badges
 * in the same CURRENT/HEAD/MERGE/BROKEN order as `buildBadgeItems` (badges.ts), comma-joined and
 * appended only when at least one applies (no trailing comma for a plain card). */
function buildAriaLabel(node: LayoutNode): string {
  const hash8 = node.hash.slice(0, 8);
  const badgeLabels: string[] = [];
  if (node.isCurrent) badgeLabels.push("current");
  if (node.isHead) badgeLabels.push("head");
  if (node.isMerge) badgeLabels.push("merge");
  if (node.isBroken) badgeLabels.push("broken");
  const suffix = badgeLabels.length > 0 ? `, ${badgeLabels.join(", ")}` : "";
  return `${hash8} — ${node.message}${suffix}`;
}

/** `author · date`, dim; author null -> just date; both null -> empty; applied===false appends
 * "· not applied" (with a leading separator only if there was already text). */
function metaText(node: LayoutNode): string {
  const parts: string[] = [];
  if (node.author !== null) parts.push(node.author);
  if (node.dateLabel !== null) parts.push(node.dateLabel);
  let text = parts.join("   ·   ");
  if (node.applied === false) text = text ? `${text}   ·   not applied` : "not applied";
  return text;
}

function buildBadges(node: LayoutNode): HTMLElement | null {
  const items = buildBadgeItems(node);
  if (items.length === 0) return null;

  const wrap = document.createElement("div");
  wrap.className = "alx-badges";
  wrap.append(...items);
  return wrap;
}

// ---------- merge hint ----------

/** Matches graph.css's `.alx-merge-hint` fixed width. */
const MERGE_HINT_WIDTH = 250;
/** N-way task: matches graph.css's `.alx-merge-hint--multi` fixed width — wider than the plain
 * 2-head hint to fit the "Merge all N heads" button alongside the (slightly longer) hint text. */
const MERGE_HINT_MULTI_WIDTH = 300;
/** Clearance between the hint box and whichever card edge it sits beside. */
const MERGE_HINT_GAP = 16;

/**
 * The green drag-to-merge banner. With exactly 2 current heads it keeps its own class and position
 * math (a separate code path below, rather than a single generalized one, specifically so that case
 * can't drift through shared aggregate math) and, since the freeform-topology task, spells out both
 * gestures a head-onto-head drop now offers. With 3+ heads it instead reads "drag one head onto
 * another to merge · " followed by an inline "Merge all N heads" button (N-way task) that posts a
 * single octopus-merge request for every current head at once — see `Handlers.onMergeAllHeads`.
 */
function buildMergeHint(
  state: AppState,
  view: ViewState,
  positions: Map<string, Pos>,
  axis: UiPrefs["axis"],
  handlers: Handlers,
  canvas: { w: number; h: number },
): HTMLElement | null {
  if (state.counts.heads < 2 || state.heads.length < 2) return null;

  // Heads can legitimately sit at ANY row (a stale branch tip can be the graph's oldest node), so
  // every placement below clamps into the canvas — without this, the bulk-side offsets overflow
  // the scrollable area whenever a head lands on the far edge (review finding, 2026-07-08).
  const clampX = (x: number, hintWidth: number): number =>
    Math.max(0, Math.min(x, canvas.w - hintWidth));

  if (state.heads.length === 2) {
    const a = positions.get(state.heads[0].id);
    const b = positions.get(state.heads[1].id);
    if (!a || !b) return null;

    const hint = document.createElement("div");
    hint.className = "alx-merge-hint";
    // Freeform-topology task: dropping a head on a head is no longer merge-or-nothing — it opens
    // the merge/move choice popover (main.ts's `onFreeformDrop`), and ⌥/Alt switches any drag to a
    // single-revision splice. The wording names both so the gestures are discoverable from the one
    // banner that was already teaching drag-and-drop. Wraps to two lines in the 250px box, which
    // still clears the head cards below it (see the placement math after this).
    hint.textContent = "drag one head onto the other to merge or move it — hold Alt/⌥ to move a single revision";

    if (axis === "horizontal") {
      // Heads cluster toward the newest end of the chain — the min-x edge under "newest-top", the
      // max-x edge under "newest-bottom" (see nodeXY's effRow mapping). Placing the hint toward
      // the OLDER/bulk side (rather than "above", as in vertical) keeps it inside the canvas
      // instead of risking a clip against whichever screen edge the newest end happens to sit at.
      const midy = (a.cy + b.cy) / 2;
      const bulkIsRightward = state.ui.order === "newest-top";
      const leftX = bulkIsRightward
        ? Math.max(a.right, b.right) + MERGE_HINT_GAP
        : Math.min(a.left, b.left) - MERGE_HINT_GAP - MERGE_HINT_WIDTH;
      hint.style.left = `${clampX(leftX, MERGE_HINT_WIDTH)}px`;
      hint.style.top = `${midy - 17}px`;
    } else {
      const midx = (a.cx + b.cx) / 2;
      const topY = Math.max(0, Math.min(a.top, b.top) - 34);
      hint.style.left = `${clampX(midx - MERGE_HINT_WIDTH / 2, MERGE_HINT_WIDTH)}px`;
      hint.style.top = `${topY}px`;
    }
    return hint;
  }

  // N-way task: 3+ heads. Same banner family (`.alx-merge-hint`, plus a `--multi` modifier for the
  // wider box/flex layout the inline button needs), positioned from the AGGREGATE of every head's
  // position rather than just the first two — for exactly 2 heads this would reduce to the exact
  // same math as the branch above, but that branch is kept separate anyway (see the doc comment).
  const headPositions = state.heads.map((h) => positions.get(h.id)).filter((p): p is Pos => p !== undefined);
  if (headPositions.length < 2) return null;

  const hint = document.createElement("div");
  hint.className = "alx-merge-hint alx-merge-hint--multi";

  const text = document.createElement("span");
  text.textContent = "drag one head onto another to merge · ";
  hint.append(text);

  const headIds = state.heads.map((h) => h.id);
  const btn = document.createElement("span");
  btn.className = view.busy ? "alx-merge-all-btn alx-merge-all-btn--disabled" : "alx-merge-all-btn";
  btn.textContent = `Merge all ${headIds.length} heads`;
  btn.addEventListener("click", () => {
    if (view.busy) return; // belt-and-suspenders with the --disabled class's pointer-events:none
    handlers.onMergeAllHeads(headIds);
  });
  hint.append(btn);

  const cy = headPositions.reduce((sum, p) => sum + p.cy, 0) / headPositions.length;
  const cx = headPositions.reduce((sum, p) => sum + p.cx, 0) / headPositions.length;
  const maxRight = Math.max(...headPositions.map((p) => p.right));
  const minLeft = Math.min(...headPositions.map((p) => p.left));
  const minTop = Math.min(...headPositions.map((p) => p.top));

  if (axis === "horizontal") {
    const bulkIsRightward = state.ui.order === "newest-top";
    const leftX = bulkIsRightward
      ? maxRight + MERGE_HINT_GAP
      : minLeft - MERGE_HINT_GAP - MERGE_HINT_MULTI_WIDTH;
    hint.style.left = `${clampX(leftX, MERGE_HINT_MULTI_WIDTH)}px`;
    hint.style.top = `${cy - 17}px`;
  } else {
    const topY = Math.max(0, minTop - 34);
    hint.style.left = `${clampX(cx - MERGE_HINT_MULTI_WIDTH / 2, MERGE_HINT_MULTI_WIDTH)}px`;
    hint.style.top = `${topY}px`;
  }
  return hint;
}
