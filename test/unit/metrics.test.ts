import { describe, it, expect } from "vitest";
import {
  CARD_W,
  COLLAPSE_H,
  GHOST_H,
  GHOST_W,
  H_ROW_GAP,
  PAD_X,
  PAD_Y,
  canvasSize,
  cardH,
  edgePathD,
  laneGapH,
  nodeSize,
  nodeXY,
  rowGap,
  type EdgeAnchor,
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

describe("metrics — nodeXY (vertical axis)", () => {
  it("x = PAD_X + lane*LANE_GAP, independent of order/density", () => {
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-top", axis: "vertical" }, 5, "comfortable").x).toBe(PAD_X);
    expect(nodeXY({ lane: 2, row: 0 }, { order: "newest-top", axis: "vertical" }, 5, "comfortable").x).toBe(
      PAD_X + 2 * 252,
    );
  });

  it("newest-top: y = PAD_Y + row*rowGap (row 0 at the top)", () => {
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-top", axis: "vertical" }, 5, "comfortable").y).toBe(PAD_Y);
    expect(nodeXY({ lane: 0, row: 1 }, { order: "newest-top", axis: "vertical" }, 5, "comfortable").y).toBe(
      PAD_Y + 134,
    );
    expect(nodeXY({ lane: 0, row: 4 }, { order: "newest-top", axis: "vertical" }, 5, "comfortable").y).toBe(
      PAD_Y + 4 * 134,
    );
  });

  it("newest-bottom: y flips so row 0 (newest) lands at the bottom", () => {
    // rowCount 5 -> rows occupy 0..4; row 0 should be at the same y as row 4 under newest-top.
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-bottom", axis: "vertical" }, 5, "comfortable").y).toBe(
      PAD_Y + 4 * 134,
    );
    expect(nodeXY({ lane: 0, row: 4 }, { order: "newest-bottom", axis: "vertical" }, 5, "comfortable").y).toBe(
      PAD_Y,
    );
    expect(nodeXY({ lane: 0, row: 2 }, { order: "newest-bottom", axis: "vertical" }, 5, "comfortable").y).toBe(
      PAD_Y + 2 * 134,
    );
  });

  it("compact density uses the compact rowGap for y", () => {
    expect(nodeXY({ lane: 0, row: 2 }, { order: "newest-top", axis: "vertical" }, 5, "compact").y).toBe(
      PAD_Y + 2 * 112,
    );
  });
});

describe("metrics — nodeXY (horizontal axis)", () => {
  it("y = PAD_Y + lane*laneGapH(density), independent of order", () => {
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-top", axis: "horizontal" }, 5, "comfortable").y).toBe(PAD_Y);
    expect(nodeXY({ lane: 2, row: 0 }, { order: "newest-top", axis: "horizontal" }, 5, "comfortable").y).toBe(
      PAD_Y + 2 * laneGapH("comfortable"),
    );
    expect(nodeXY({ lane: 2, row: 0 }, { order: "newest-bottom", axis: "horizontal" }, 5, "comfortable").y).toBe(
      PAD_Y + 2 * laneGapH("comfortable"),
    );
  });

  it("compact density uses the compact laneGapH for y", () => {
    expect(nodeXY({ lane: 2, row: 0 }, { order: "newest-top", axis: "horizontal" }, 5, "compact").y).toBe(
      PAD_Y + 2 * laneGapH("compact"),
    );
  });

  it("newest-top: x = PAD_X + row*H_ROW_GAP (row 0/newest at the LEFT)", () => {
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-top", axis: "horizontal" }, 5, "comfortable").x).toBe(PAD_X);
    expect(nodeXY({ lane: 0, row: 1 }, { order: "newest-top", axis: "horizontal" }, 5, "comfortable").x).toBe(
      PAD_X + H_ROW_GAP,
    );
    expect(nodeXY({ lane: 0, row: 4 }, { order: "newest-top", axis: "horizontal" }, 5, "comfortable").x).toBe(
      PAD_X + 4 * H_ROW_GAP,
    );
  });

  it("newest-bottom (default): x flips so row 0 (newest) lands at the RIGHT (highest x)", () => {
    // rowCount 5 -> rows occupy 0..4; row 0 should be at the same x as row 4 under newest-top.
    expect(nodeXY({ lane: 0, row: 0 }, { order: "newest-bottom", axis: "horizontal" }, 5, "comfortable").x).toBe(
      PAD_X + 4 * H_ROW_GAP,
    );
    expect(nodeXY({ lane: 0, row: 4 }, { order: "newest-bottom", axis: "horizontal" }, 5, "comfortable").x).toBe(
      PAD_X,
    );
    expect(nodeXY({ lane: 0, row: 2 }, { order: "newest-bottom", axis: "horizontal" }, 5, "comfortable").x).toBe(
      PAD_X + 2 * H_ROW_GAP,
    );
  });

  it("H_ROW_GAP is the same both densities (card width doesn't vary with density)", () => {
    const comfortable = nodeXY({ lane: 0, row: 3 }, { order: "newest-top", axis: "horizontal" }, 5, "comfortable").x;
    const compact = nodeXY({ lane: 0, row: 3 }, { order: "newest-top", axis: "horizontal" }, 5, "compact").x;
    expect(comfortable).toBe(compact);
  });
});

describe("metrics — canvasSize (vertical axis)", () => {
  it("computes W/H from laneCount/rowCount per the design formula", () => {
    // laneCount 2 (maxLane 1), rowCount 13 (maxRow 12), comfortable density.
    const size = canvasSize({ laneCount: 2, rowCount: 13 }, { axis: "vertical" }, "comfortable");
    expect(size.w).toBe(PAD_X + 1 * 252 + CARD_W + 80);
    expect(size.h).toBe(PAD_Y + 12 * 134 + 92 + 60);
  });

  it("compact density shrinks H via the compact rowGap/cardH", () => {
    const size = canvasSize({ laneCount: 2, rowCount: 13 }, { axis: "vertical" }, "compact");
    expect(size.h).toBe(PAD_Y + 12 * 112 + 76 + 60);
  });

  it("laneCount/rowCount of 0 (empty graph) doesn't go negative", () => {
    const size = canvasSize({ laneCount: 0, rowCount: 0 }, { axis: "vertical" }, "comfortable");
    expect(size.w).toBe(PAD_X + 0 * 252 + CARD_W + 80);
    expect(size.h).toBe(PAD_Y + 0 * 134 + 92 + 60);
  });
});

describe("metrics — canvasSize (horizontal axis)", () => {
  it("swaps the roles of row/lane extents: w driven by rowCount, h by laneCount", () => {
    // laneCount 2 (maxLane 1), rowCount 13 (maxRow 12), comfortable density.
    const size = canvasSize({ laneCount: 2, rowCount: 13 }, { axis: "horizontal" }, "comfortable");
    expect(size.w).toBe(PAD_X + 12 * H_ROW_GAP + CARD_W + 80);
    expect(size.h).toBe(PAD_Y + 1 * laneGapH("comfortable") + cardH("comfortable") + 60);
  });

  it("compact density shrinks H via the compact laneGapH/cardH", () => {
    const size = canvasSize({ laneCount: 2, rowCount: 13 }, { axis: "horizontal" }, "compact");
    expect(size.h).toBe(PAD_Y + 1 * laneGapH("compact") + cardH("compact") + 60);
  });

  it("laneCount/rowCount of 0 (empty graph) doesn't go negative", () => {
    const size = canvasSize({ laneCount: 0, rowCount: 0 }, { axis: "horizontal" }, "comfortable");
    expect(size.w).toBe(PAD_X + 0 * H_ROW_GAP + CARD_W + 80);
    expect(size.h).toBe(PAD_Y + 0 * laneGapH("comfortable") + cardH("comfortable") + 60);
  });
});

describe("metrics — edgePathD (vertical axis)", () => {
  const upperAnchor: EdgeAnchor = { cx: 100, cy: 50, top: 20, bottom: 80, left: 50, right: 150 };
  const lowerAnchor: EdgeAnchor = { cx: 100, cy: 200, top: 170, bottom: 230, left: 50, right: 150 };

  it("bezier from the upper card's bottom-center to the lower card's top-center", () => {
    expect(edgePathD(upperAnchor, lowerAnchor, "vertical")).toBe("M 100 80 C 100 125 100 125 100 170");
  });

  it("orders by `top` regardless of argument order (either endpoint may be physically above)", () => {
    expect(edgePathD(lowerAnchor, upperAnchor, "vertical")).toBe("M 100 80 C 100 125 100 125 100 170");
  });
});

describe("metrics — edgePathD (horizontal axis)", () => {
  const lefterAnchor: EdgeAnchor = { cx: 50, cy: 50, top: 20, bottom: 80, left: 0, right: 100 };
  const righterAnchor: EdgeAnchor = { cx: 250, cy: 150, top: 120, bottom: 180, left: 200, right: 300 };

  it("bezier from the lefter card's right-center to the righter card's left-center", () => {
    // sx=100 (lefter.right), sy=50 (lefter.cy); ex=200 (righter.left), ey=150 (righter.cy); a
    // horizontal-only edge would have sx<ex with sy===ey, per the brief's Playwright check.
    expect(edgePathD(lefterAnchor, righterAnchor, "horizontal")).toBe("M 100 50 C 150 50 150 150 200 150");
  });

  it("orders by `left` regardless of argument order", () => {
    expect(edgePathD(righterAnchor, lefterAnchor, "horizontal")).toBe("M 100 50 C 150 50 150 150 200 150");
  });

  it("same-lane edge (equal cy): sx < ex with sy === ey", () => {
    const a: EdgeAnchor = { cx: 50, cy: 100, top: 70, bottom: 130, left: 0, right: 100 };
    const b: EdgeAnchor = { cx: 250, cy: 100, top: 70, bottom: 130, left: 200, right: 300 };
    const d = edgePathD(a, b, "horizontal");
    expect(d).toBe("M 100 100 C 150 100 150 100 200 100");
    // "M sx sy C ... ex ey" — parse the start/end points directly rather than re-deriving them.
    const parts = d.split(" ");
    const sx = Number(parts[1]);
    const sy = Number(parts[2]);
    const ex = Number(parts[parts.length - 2]);
    const ey = Number(parts[parts.length - 1]);
    expect(sx).toBeLessThan(ex);
    expect(sy).toBe(ey);
  });
});
