/**
 * Pure pixel math for the graph canvas — no DOM, no imports beyond types. Ported 1:1 from the
 * design file's `renderVals()` (CARD_W/ROW_GAP/etc. + wOf/hOf/leftOf/topOf/canvasW/canvasH), with
 * one adaptation: the design's demo data hand-numbers rows oldest-first, but the real
 * `layoutGraph()` output numbers row 0 = newest (see core/layout.ts). The formulas below encode
 * *our* row direction, not the design file's literal `topOf`.
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

export type Density = UiPrefs["density"];

/** Card height: comfortable 92px, compact 76px. */
export function cardH(density: Density): 92 | 76 {
  return density === "compact" ? 76 : 92;
}

/** Vertical spacing between rows: comfortable 134px, compact 112px. */
export function rowGap(density: Density): 134 | 112 {
  return density === "compact" ? 112 : 134;
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
 */
export function nodeXY(
  node: Pick<LayoutNode, "lane" | "row">,
  ui: Pick<UiPrefs, "order">,
  rowCount: number,
  density: Density,
): { x: number; y: number } {
  const gap = rowGap(density);
  const x = PAD_X + node.lane * LANE_GAP;
  const y =
    ui.order === "newest-top" ? PAD_Y + node.row * gap : PAD_Y + (rowCount - 1 - node.row) * gap;
  return { x, y };
}

/**
 * Full scrollable canvas extent. Per the design: W = PAD_X + maxLane*LANE_GAP + CARD_W + 80;
 * H = PAD_Y + (rowCount-1)*rowGap + cardH + 60. `ui` isn't consulted — orientation only mirrors
 * node positions within the same bounding box, it never changes the box itself.
 */
export function canvasSize(
  layout: Pick<GraphLayout, "laneCount" | "rowCount">,
  _ui: Pick<UiPrefs, "order">,
  density: Density,
): { w: number; h: number } {
  const maxLane = Math.max(layout.laneCount - 1, 0);
  const maxRow = Math.max(layout.rowCount - 1, 0);
  const w = PAD_X + maxLane * LANE_GAP + CARD_W + 80;
  const h = PAD_Y + maxRow * rowGap(density) + cardH(density) + 60;
  return { w, h };
}
