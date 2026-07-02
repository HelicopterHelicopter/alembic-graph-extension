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
import { canvasSize, nodeSize, nodeXY, type Density } from "./metrics";

export interface ViewState {
  selectedId: string | null;
  /** Last detail payload the host sent for the current selection; null while unknown/loading or
   * when the selected id has no detail (ghost/collapse). */
  detail: RevisionDetail | null;
  /** Whether the panel should be shown at all — independent of `detail`, so closing it (✕) keeps
   * the card selection/highlight while hiding the panel (matches the design's `closeDetails`). */
  detailOpen: boolean;
}

export interface Handlers {
  onSelect(id: string): void;
  onToggleOrder(order: UiPrefs["order"]): void;
  onToggleDensity(density: UiPrefs["density"]): void;
  onExpandCollapse(): void;
  onCloseDetail(): void;
  onOpenFile(id: string): void;
}

interface Pos {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  top: number;
  bottom: number;
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
  const toolbar = buildToolbar(state, handlers);
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

function buildToolbar(state: AppState, handlers: Handlers): HTMLElement {
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

  const orderLabel = document.createElement("span");
  orderLabel.className = "alx-order-label";
  orderLabel.textContent = "Order";

  const orderGroup = document.createElement("div");
  orderGroup.className = "alx-toggle-group";
  orderGroup.append(
    makeToggle("Newest ↓", state.ui.order === "newest-bottom", () => handlers.onToggleOrder("newest-bottom")),
    makeToggle("Newest ↑", state.ui.order === "newest-top", () => handlers.onToggleOrder("newest-top")),
  );

  const densityGroup = document.createElement("div");
  densityGroup.className = "alx-toggle-group";
  densityGroup.append(
    makeToggle("Comfortable", state.ui.density === "comfortable", () => handlers.onToggleDensity("comfortable")),
    makeToggle("Compact", state.ui.density === "compact", () => handlers.onToggleDensity("compact")),
  );

  toolbar.append(label, sep, headsChip, revCount, spacer, orderLabel, orderGroup, densityGroup);
  return toolbar;
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
    map.set(node.id, { x, y, w, h, cx: x + w / 2, top: y, bottom: y + h });
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

  const viewport = document.createElement("div");
  viewport.className = "alx-canvas-viewport";

  const canvas = document.createElement("div");
  canvas.className = "alx-canvas";
  canvas.style.width = `${size.w}px`;
  canvas.style.height = `${size.h}px`;

  canvas.append(buildEdgesSvg(layout, size, positions, state.laneColors));

  for (const node of layout.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    canvas.append(buildNodeElement(node, state, view, handlers, pos, density));
  }

  const mergeHint = buildMergeHint(state, positions);
  if (mergeHint) canvas.append(mergeHint);

  viewport.append(canvas);
  return viewport;
}

function buildEdgesSvg(
  layout: GraphLayout,
  size: { w: number; h: number },
  positions: Map<string, Pos>,
  laneColors: string[],
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

    // Anchor = upper card's bottom-center -> lower card's top-center.
    const upper = a.top <= b.top ? a : b;
    const lower = a.top <= b.top ? b : a;
    const sx = upper.cx;
    const sy = upper.bottom;
    const ex = lower.cx;
    const ey = lower.top;
    const mid = (sy + ey) / 2;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${sx} ${sy} C ${sx} ${mid} ${ex} ${mid} ${ex} ${ey}`);

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
    wrapper.append(buildCollapseCard(node, handlers));
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

function buildRevisionCard(node: LayoutNode, view: ViewState, density: Density, laneColors: string[]): HTMLElement {
  const selected = node.id === view.selectedId;
  const laneColor = laneColors[node.lane] ?? laneColors[0] ?? "#4aa3ff";

  const card = document.createElement("div");
  card.className = [
    "alx-card",
    density === "compact" ? "alx-card--compact" : null,
    selected ? "alx-card--selected" : null,
  ]
    .filter((c): c is string => c !== null)
    .join(" ");

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

function buildMergeHint(state: AppState, positions: Map<string, Pos>): HTMLElement | null {
  if (state.counts.heads < 2 || state.heads.length < 2) return null;
  const a = positions.get(state.heads[0].id);
  const b = positions.get(state.heads[1].id);
  if (!a || !b) return null;

  const midx = (a.cx + b.cx) / 2;
  const topY = Math.min(a.top, b.top) - 34;

  const hint = document.createElement("div");
  hint.className = "alx-merge-hint";
  hint.style.left = `${midx - 125}px`;
  hint.style.top = `${topY}px`;
  hint.textContent = "drag one head onto the other to merge  ⇄";
  return hint;
}
