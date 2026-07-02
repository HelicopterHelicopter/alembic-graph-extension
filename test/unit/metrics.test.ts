import { describe, it, expect } from "vitest";
import {
  CARD_W,
  COLLAPSE_H,
  GHOST_H,
  GHOST_W,
  PAD_X,
  PAD_Y,
  canvasSize,
  cardH,
  nodeSize,
  nodeXY,
  rowGap,
} from "../../src/webview/graph/metrics";

describe("metrics — cardH / rowGap", () => {
  it("cardH: comfortable 92, compact 76", () => {
    expect(cardH("comfortable")).toBe(92);
    expect(cardH("compact")).toBe(76);
  });

  it("rowGap: comfortable 134, compact 112", () => {
    expect(rowGap("comfortable")).toBe(134);
    expect(rowGap("compact")).toBe(112);
  });
});

describe("metrics — nodeSize", () => {
  it("ghost: fixed 190x54 regardless of density", () => {
    expect(nodeSize({ kind: "ghost" }, "comfortable")).toEqual({ w: GHOST_W, h: GHOST_H });
    expect(nodeSize({ kind: "ghost" }, "compact")).toEqual({ w: GHOST_W, h: GHOST_H });
  });

  it("collapse: card width, fixed 42px height regardless of density", () => {
    expect(nodeSize({ kind: "collapse" }, "comfortable")).toEqual({ w: CARD_W, h: COLLAPSE_H });
    expect(nodeSize({ kind: "collapse" }, "compact")).toEqual({ w: CARD_W, h: COLLAPSE_H });
  });

  it("revision: card width, density-dependent height", () => {
    expect(nodeSize({ kind: "revision" }, "comfortable")).toEqual({ w: CARD_W, h: 92 });
    expect(nodeSize({ kind: "revision" }, "compact")).toEqual({ w: CARD_W, h: 76 });
  });
});

describe("metrics — nodeXY", () => {
  it("x = PAD_X + lane*LANE_GAP, independent of order/density", () => {
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-top" }, 5, "comfortable").x).toBe(PAD_X);
    expect(nodeXY({ lane: 2, row: 0 }, { order: "newest-top" }, 5, "comfortable").x).toBe(PAD_X + 2 * 252);
  });

  it("newest-top: y = PAD_Y + row*rowGap (row 0 at the top)", () => {
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-top" }, 5, "comfortable").y).toBe(PAD_Y);
    expect(nodeXY({ lane: 0, row: 1 }, { order: "newest-top" }, 5, "comfortable").y).toBe(PAD_Y + 134);
    expect(nodeXY({ lane: 0, row: 4 }, { order: "newest-top" }, 5, "comfortable").y).toBe(PAD_Y + 4 * 134);
  });

  it("newest-bottom: y flips so row 0 (newest) lands at the bottom", () => {
    // rowCount 5 -> rows occupy 0..4; row 0 should be at the same y as row 4 under newest-top.
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-bottom" }, 5, "comfortable").y).toBe(PAD_Y + 4 * 134);
    expect(nodeXY({ lane: 0, row: 4 }, { order: "newest-bottom" }, 5, "comfortable").y).toBe(PAD_Y);
    expect(nodeXY({ lane: 0, row: 2 }, { order: "newest-bottom" }, 5, "comfortable").y).toBe(PAD_Y + 2 * 134);
  });

  it("compact density uses the compact rowGap for y", () => {
    expect(nodeXY({ lane: 0, row: 2 }, { order: "newest-top" }, 5, "compact").y).toBe(PAD_Y + 2 * 112);
  });
});

describe("metrics — canvasSize", () => {
  it("computes W/H from laneCount/rowCount per the design formula", () => {
    // laneCount 2 (maxLane 1), rowCount 13 (maxRow 12), comfortable density.
    const size = canvasSize({ laneCount: 2, rowCount: 13 }, { order: "newest-bottom" }, "comfortable");
    expect(size.w).toBe(PAD_X + 1 * 252 + CARD_W + 80);
    expect(size.h).toBe(PAD_Y + 12 * 134 + 92 + 60);
  });

  it("compact density shrinks H via the compact rowGap/cardH", () => {
    const size = canvasSize({ laneCount: 2, rowCount: 13 }, { order: "newest-bottom" }, "compact");
    expect(size.h).toBe(PAD_Y + 12 * 112 + 76 + 60);
  });

  it("laneCount/rowCount of 0 (empty graph) doesn't go negative", () => {
    const size = canvasSize({ laneCount: 0, rowCount: 0 }, { order: "newest-top" }, "comfortable");
    expect(size.w).toBe(PAD_X + 0 * 252 + CARD_W + 80);
    expect(size.h).toBe(PAD_Y + 0 * 134 + 92 + 60);
  });

  it("order does not affect canvas extent (same box, mirrored contents)", () => {
    const top = canvasSize({ laneCount: 2, rowCount: 13 }, { order: "newest-top" }, "comfortable");
    const bottom = canvasSize({ laneCount: 2, rowCount: 13 }, { order: "newest-bottom" }, "comfortable");
    expect(top).toEqual(bottom);
  });
});
