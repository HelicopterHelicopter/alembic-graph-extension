/**
 * Migration graph canvas — DOM construction only (createElement/textContent/setAttribute; never
 * innerHTML with state data, since messages/hashes/branch labels/file paths all come straight
 * from files in the user's workspace). Faithful port of the design file's `renderVals()` (see
 * `design/Alembic Graph.dc.html`), adapted to real `AppState`/`LayoutNode` shapes and the theme
 * token layer in graph.css. Per the brief, only position/size/lane-color/z-index are dynamic
 * inline styles — every other visual rule lives in a graph.css class.
 */
import type { GraphLayout, LayoutNode } from "../../core/types";
import type { AppState, RevisionDetail, UiPrefs } from "../../protocol/messages";
import { buildBadgeItems } from "./badges";
import { buildDetailPanel, type DetailHandlers } from "./detail";
import { canvasSize, edgePathD, nodeSize, nodeXY, type Density } from "./metrics";

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
    const detailHandlers: DetailHandlers = { onClose: handlers.onCloseDetail, onOpenFile: handlers.onOpenFile };
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

  const brokenParentByChild = brokenParentByChildMap(state);
  for (const node of layout.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    canvas.append(buildNodeElement(node, state, view, handlers, pos, density, brokenParentByChild));
  }

  const mergeHint = buildMergeHint(state, positions, ui.axis);
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
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", edgePathD(a, b, axis));
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
  }

  return svg;
}

// ---------- node cards ----------

/**
 * Maps each broken revision's id to the (first) missing parent id it revises — derived from
 * `state.problems`'s `broken-down-revision` entries (`revisionIds: [childId, missingId]`, see
 * core/types.ts) rather than re-deriving it from `layout.nodes`, since a ghost's layout node could
 * in principle be absent from a collapsed view while the problem list always reflects the full,
 * uncollapsed graph. Used to give a broken NON-head revision card its own repoint-drag handle
 * (Task 15) — the ghost id it should repoint when dragged is whatever this map says, NOT its own
 * node id.
 */
function brokenParentByChildMap(state: AppState): Map<string, string> {
  const map = new Map<string, string>();
  for (const problem of state.problems) {
    if (problem.kind !== "broken-down-revision") continue;
    const [childId, missingId] = problem.revisionIds;
    if (!map.has(childId)) map.set(childId, missingId);
  }
  return map;
}

function buildNodeElement(
  node: LayoutNode,
  state: AppState,
  view: ViewState,
  handlers: Handlers,
  pos: Pos,
  density: Density,
  brokenParentByChild: Map<string, string>,
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
    return wrapper;
  }
  if (node.kind === "collapse") {
    const collapse = buildCollapseCard(node, handlers);
    collapse.dataset.nodeId = node.id;
    wrapper.append(collapse);
    return wrapper;
  }

  const card = buildRevisionCard(node, view, density, state.laneColors, brokenParentByChild);
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
  brokenParentByChild: Map<string, string>,
): HTMLElement {
  const selected = node.id === view.selectedId;
  const laneColor = laneColors[node.lane] ?? laneColors[0] ?? "#4aa3ff";

  // Task 15: a BROKEN, NON-head card is also a repoint-drag source (dragging it re-points its own
  // missing parent — same outcome as dragging that ghost directly). A head wins over broken —
  // dragging a broken HEAD card is still a merge (Task 14), never a repoint — so this is
  // deliberately gated on `!node.isHead` and only set when the missing-parent lookup actually
  // resolves (defensive: it always should for a node with isBroken true, see brokenParentByChildMap).
  const repointGhostId = !node.isHead && node.isBroken ? (brokenParentByChild.get(node.id) ?? null) : null;

  const card = document.createElement("div");
  card.className = [
    "alx-card",
    density === "compact" ? "alx-card--compact" : null,
    selected ? "alx-card--selected" : null,
    // Task 14/15: HEAD cards drag-to-merge; broken non-head cards drag-to-repoint. touch-action:
    // none lives on this class too (see graph.css) so it's only applied where a drag can start.
    node.isHead || repointGhostId !== null ? "alx-card--draggable" : null,
  ]
    .filter((c): c is string => c !== null)
    .join(" ");
  // dnd.ts event-delegates off these — data-node-id on every revision card (also set on
  // ghost/collapse cards above, for hit-testing reuse), data-head only on the subset that's a
  // legal drag source/drop target for merge (Task 14), data-repoint-ghost-id only on the subset
  // that's a legal repoint-drag source (Task 15 — see buildGhostCard for the ghost-card side).
  card.dataset.nodeId = node.id;
  if (node.isHead) card.dataset.head = "true";
  if (repointGhostId !== null) card.dataset.repointGhostId = repointGhostId;

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
/** Clearance between the hint box and whichever card edge it sits beside. */
const MERGE_HINT_GAP = 16;

function buildMergeHint(state: AppState, positions: Map<string, Pos>, axis: UiPrefs["axis"]): HTMLElement | null {
  if (state.counts.heads < 2 || state.heads.length < 2) return null;
  const a = positions.get(state.heads[0].id);
  const b = positions.get(state.heads[1].id);
  if (!a || !b) return null;

  const hint = document.createElement("div");
  hint.className = "alx-merge-hint";
  hint.textContent = "drag one head onto the other to merge  ⇄";

  if (axis === "horizontal") {
    // Heads cluster toward the newest end of the chain — the min-x edge under "newest-top", the
    // max-x edge under "newest-bottom" (see nodeXY's effRow mapping). Placing the hint toward the
    // OLDER/bulk side (rather than "above", as in vertical) keeps it inside the canvas instead of
    // risking a clip against whichever screen edge the newest end happens to sit at.
    const midy = (a.cy + b.cy) / 2;
    const bulkIsRightward = state.ui.order === "newest-top";
    const leftX = bulkIsRightward
      ? Math.max(a.right, b.right) + MERGE_HINT_GAP
      : Math.min(a.left, b.left) - MERGE_HINT_GAP - MERGE_HINT_WIDTH;
    hint.style.left = `${leftX}px`;
    hint.style.top = `${midy - 17}px`;
  } else {
    const midx = (a.cx + b.cx) / 2;
    const topY = Math.min(a.top, b.top) - 34;
    hint.style.left = `${midx - MERGE_HINT_WIDTH / 2}px`;
    hint.style.top = `${topY}px`;
  }
  return hint;
}
