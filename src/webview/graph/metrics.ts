/**
 * Pure pixel math for the graph canvas — no DOM, no imports beyond types. Ported 1:1 from the
 * design file's `renderVals()` (CARD_W/ROW_GAP/etc. + wOf/hOf/leftOf/topOf/canvasW/canvasH), with
 * one adaptation: the design's demo data hand-numbers rows oldest-first, but the real
 * `layoutGraph()` output numbers row 0 = newest (see core/layout.ts). The formulas below encode
 * *our* row direction, not the design file's literal `topOf`.
 *
 * Task H (axis): the layout engine's abstract (lane, row) output never changes — `axis` is purely
 * a pixel-mapping choice made here. `"vertical"` is the original layout: row -> y (mirrored by
 * `order`), lane -> x. `"horizontal"` (the default) transposes that: row -> x (still mirrored by
 * `order`, root left / heads right by default), lane -> y. Every function below branches on
 * `ui.axis` and both `render.ts` and `svgExport.ts` consume the same branch, so the live canvas and
 * the standalone SVG export can never draw a different layout for the same state.
 */
import type { GraphLayout, LayoutNode } from "../../core/types";
import type { UiPrefs } from "../../protocol/messages";

export const CARD_W = 226;
export const LANE_GAP = 252;
export const PAD_X = 44;
export const PAD_Y = 34;
export const GHOST_W = 190;
export const GHOST_H = 54;
export const COLLAPSE_H = 42;
/** Horizontal axis's row (chain) gap — CARD_W + 40px breathing room, same both densities (card
 * WIDTH never varies with density, only height does). */
export const H_ROW_GAP = 266;

export type Density = UiPrefs["density"];

/** Card height: comfortable 92px, compact 76px. */
export function cardH(density: Density): 92 | 76 {
  return density === "compact" ? 76 : 92;
}

/** Vertical spacing between rows: comfortable 134px, compact 112px. */
export function rowGap(density: Density): 134 | 112 {
  return density === "compact" ? 112 : 134;
}

/** Horizontal axis's lane (branch) gap — cardH(density) + 40px, so lanes stacked vertically never
 * overlap regardless of density: comfortable 132px, compact 116px. */
export function laneGapH(density: Density): 132 | 116 {
  return density === "compact" ? 116 : 132;
}

/** Per-kind footprint: ghost and collapse nodes override the standard card size. */
export function nodeSize(node: Pick<LayoutNode, "kind">, density: Density): { w: number; h: number } {
  if (node.kind === "ghost") return { w: GHOST_W, h: GHOST_H };
  if (node.kind === "collapse") return { w: CARD_W, h: COLLAPSE_H };
  return { w: CARD_W, h: cardH(density) };
}

/**
 * Top-left pixel position for a node. `rowCount` (not the node's own row) drives the
 * newest-bottom flip, since it needs the full row span to mirror consistently.
 *
 * Horizontal axis: the row (chain) axis moves to x, using the same `order`-driven mirroring as
 * vertical's row->y (newest-bottom flips `effRow` so the newest row lands at the highest x, i.e.
 * the RIGHT edge — see the `axis` field's doc comment on `UiPrefs`); the lane (branch) axis moves
 * to y, unmirrored (lane 0 always at the top), same as vertical's lane->x is always unmirrored
 * (lane 0 always at the left).
 */
export function nodeXY(
  node: Pick<LayoutNode, "lane" | "row">,
  ui: Pick<UiPrefs, "order" | "axis">,
  rowCount: number,
  density: Density,
): { x: number; y: number } {
  if (ui.axis === "horizontal") {
    const effRow = ui.order === "newest-bottom" ? rowCount - 1 - node.row : node.row;
    const x = PAD_X + effRow * H_ROW_GAP;
    const y = PAD_Y + node.lane * laneGapH(density);
    return { x, y };
  }
  const gap = rowGap(density);
  const x = PAD_X + node.lane * LANE_GAP;
  const y =
    ui.order === "newest-top" ? PAD_Y + node.row * gap : PAD_Y + (rowCount - 1 - node.row) * gap;
  return { x, y };
}

/**
 * Full scrollable canvas extent. Per the design: W = PAD_X + maxLane*LANE_GAP + CARD_W + 80;
 * H = PAD_Y + (rowCount-1)*rowGap + cardH + 60. `order` isn't consulted — it only mirrors node
 * positions within the same bounding box, it never changes the box itself. `axis` DOES change the
 * box: horizontal swaps which of (lane, row) drives w vs h, per `nodeXY`'s own axis mapping above
 * — the `+CARD_W+80` / `+cardH(density)+60` end-padding terms stay attached to w/h respectively
 * (not to lane/row), since a card's width/height is a property of the SCREEN axis it occupies, not
 * of which abstract layout measure happens to drive that axis.
 */
export function canvasSize(
  layout: Pick<GraphLayout, "laneCount" | "rowCount">,
  ui: Pick<UiPrefs, "axis">,
  density: Density,
): { w: number; h: number } {
  const maxLane = Math.max(layout.laneCount - 1, 0);
  const maxRow = Math.max(layout.rowCount - 1, 0);
  if (ui.axis === "horizontal") {
    const w = PAD_X + maxRow * H_ROW_GAP + CARD_W + 80;
    const h = PAD_Y + maxLane * laneGapH(density) + cardH(density) + 60;
    return { w, h };
  }
  const w = PAD_X + maxLane * LANE_GAP + CARD_W + 80;
  const h = PAD_Y + maxRow * rowGap(density) + cardH(density) + 60;
  return { w, h };
}

/** Corners of a positioned node that the edge-path math needs — the subset of render.ts's `Pos`
 * (and svgExport.ts's mirrored `Pos`) common to both canvas renderers. */
export interface EdgeAnchor {
  cx: number;
  cy: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * `EdgeAnchor` for one node, with its top-left position optionally nudged by `(overrideDx,
 * overrideDy)` — the live edge-follow math (dnd.ts's `onDragMove` -> main.ts) needs this for
 * exactly one endpoint (the node currently being dragged) per recompute, while the OTHER endpoint
 * stays at its plain, unmodified position (defaults 0/0 cover that case without a separate code
 * path). Deliberately pure/DOM-free — same reasoning as every other function in this file: no
 * `getBoundingClientRect()` (zoom-scaled, and a card's rect briefly lags a `transform` write
 * anyway), just the same `nodeXY`/`nodeSize` math `render.ts`'s `computePositions` already runs,
 * so a live-dragged edge can never visually disagree with the settled layout it's a live preview
 * of.
 */
export function nodeAnchor(
  node: Pick<LayoutNode, "lane" | "row" | "kind">,
  ui: Pick<UiPrefs, "order" | "axis">,
  rowCount: number,
  density: Density,
  overrideDx = 0,
  overrideDy = 0,
): EdgeAnchor {
  const { x, y } = nodeXY(node, ui, rowCount, density);
  const { w, h } = nodeSize(node, density);
  const left = x + overrideDx;
  const top = y + overrideDy;
  return { cx: left + w / 2, cy: top + h / 2, top, bottom: top + h, left, right: left + w };
}

/**
 * SVG `<path>` `d` string for one parent→child edge — shared by the live DOM canvas (render.ts's
 * `buildEdgesSvg`) and the standalone SVG export (svgExport.ts) so the two renderers can never draw
 * visibly different curves for the same layout.
 *
 * Vertical: a cubic bezier from the visually-upper card's bottom-center to the visually-lower
 * card's top-center (control points held at the vertical midpoint, directly under/above each
 * anchor, for a symmetric S-curve). Orders by `top` rather than trusting `a`/`b` to already be
 * parent/child in draw order, since layout order flips under newest-top vs newest-bottom (see
 * `nodeXY`) and either endpoint can end up physically above the other.
 *
 * Horizontal: the transposed equivalent — bottom/top become right/left, and orders by `left`
 * instead of `top` for the same reason (order flip can put either endpoint further right).
 */
export function edgePathD(a: EdgeAnchor, b: EdgeAnchor, axis: UiPrefs["axis"]): string {
  if (axis === "horizontal") {
    const lefter = a.left <= b.left ? a : b;
    const righter = a.left <= b.left ? b : a;
    const sx = lefter.right;
    const sy = lefter.cy;
    const ex = righter.left;
    const ey = righter.cy;
    const mid = (sx + ex) / 2;
    return `M ${sx} ${sy} C ${mid} ${sy} ${mid} ${ey} ${ex} ${ey}`;
  }
  const upper = a.top <= b.top ? a : b;
  const lower = a.top <= b.top ? b : a;
  const sx = upper.cx;
  const sy = upper.bottom;
  const ex = lower.cx;
  const ey = lower.top;
  const mid = (sy + ey) / 2;
  return `M ${sx} ${sy} C ${sx} ${mid} ${ex} ${mid} ${ex} ${ey}`;
}
