import { describe, it, expect } from "vitest";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  arrowKeyTarget,
  clampZoom,
  computeAncestorSet,
  fitScroll,
  fitZoom,
  findLaneNeighbor,
  findRowNeighbor,
  matchesQuery,
  nextMatchIndex,
  prevMatchIndex,
  stepZoom,
  verticalRowDelta,
  zoomAnchorScroll,
} from "../../src/webview/graph/uxMath";

describe("uxMath — zoom clamp/step", () => {
  it("clampZoom clamps to [0.5, 1.5]", () => {
    expect(clampZoom(0.2)).toBe(ZOOM_MIN);
    expect(clampZoom(3)).toBe(ZOOM_MAX);
    expect(clampZoom(1.2)).toBe(1.2);
  });

  it("stepZoom moves by 0.1 and clamps at the bounds", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1.1);
    expect(stepZoom(1, -1)).toBeCloseTo(0.9);
    expect(stepZoom(1.5, 1)).toBe(1.5);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it("stepZoom doesn't accumulate float drift over repeated steps", () => {
    let z = 0.5;
    for (let i = 0; i < 10; i++) z = stepZoom(z, 1);
    expect(z).toBe(1.5);
  });
});

describe("uxMath — zoomAnchorScroll", () => {
  it("keeps the content point under the anchor fixed on screen when zooming in", () => {
    // At zoom 1, scrollLeft 100 + offsetX 50 = content x 150. Zooming to 2x should put that same
    // content point (300) back under offsetX 50: scrollLeft = 300 - 50 = 250.
    const result = zoomAnchorScroll({ scrollLeft: 100, scrollTop: 0 }, { offsetX: 50, offsetY: 0 }, 1, 2);
    expect(result.scrollLeft).toBeCloseTo(250);
  });

  it("keeps the content point fixed when zooming out", () => {
    // zoom 2 -> 1: content x = (200+50)/2 = 125; new scrollLeft = 125*1 - 50 = 75.
    const result = zoomAnchorScroll({ scrollLeft: 200, scrollTop: 0 }, { offsetX: 50, offsetY: 0 }, 2, 1);
    expect(result.scrollLeft).toBeCloseTo(75);
  });

  it("handles X and Y independently", () => {
    const result = zoomAnchorScroll({ scrollLeft: 100, scrollTop: 40 }, { offsetX: 10, offsetY: 20 }, 1, 1.5);
    expect(result.scrollLeft).toBeCloseTo((100 + 10) * 1.5 - 10);
    expect(result.scrollTop).toBeCloseTo((40 + 20) * 1.5 - 20);
  });

  it("never returns a negative scroll", () => {
    const result = zoomAnchorScroll({ scrollLeft: 0, scrollTop: 0 }, { offsetX: 500, offsetY: 500 }, 1.5, 0.5);
    expect(result.scrollLeft).toBeGreaterThanOrEqual(0);
    expect(result.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it("no-op (unchanged scroll) when oldZoom === newZoom", () => {
    const result = zoomAnchorScroll({ scrollLeft: 77, scrollTop: 33 }, { offsetX: 12, offsetY: 8 }, 1, 1);
    expect(result.scrollLeft).toBeCloseTo(77);
    expect(result.scrollTop).toBeCloseTo(33);
  });
});

describe("uxMath — fitZoom / fitScroll", () => {
  it("fitZoom picks the smaller of width/height ratios, clamped", () => {
    // canvas 2000x1000, viewport 1000x1000 -> min(0.5, 1) = 0.5 (also the floor, so clamp is a no-op).
    expect(fitZoom({ w: 2000, h: 1000 }, { w: 1000, h: 1000 })).toBeCloseTo(0.5);
    // canvas 400x300, viewport 1000x1000 -> min(2.5, 3.33) = 2.5, clamped to ZOOM_MAX (1.5).
    expect(fitZoom({ w: 400, h: 300 }, { w: 1000, h: 1000 })).toBe(ZOOM_MAX);
  });

  it("fitZoom falls back to 1.0 for a degenerate size", () => {
    expect(fitZoom({ w: 0, h: 500 }, { w: 500, h: 500 })).toBe(1);
    expect(fitZoom({ w: 500, h: 500 }, { w: 0, h: 500 })).toBe(1);
  });

  it("fitScroll centers the scaled canvas in the viewport", () => {
    // canvas 1000x1000 at zoom 0.5 -> 500x500 scaled, viewport 800x800: canvas is smaller, so
    // centering clamps to 0 (never negative-scrolled).
    expect(fitScroll({ w: 1000, h: 1000 }, { w: 800, h: 800 }, 0.5)).toEqual({ scrollLeft: 0, scrollTop: 0 });
    // canvas 2000x1000 at zoom 1 -> viewport 800x600: scrollLeft = (2000-800)/2 = 600, scrollTop = (1000-600)/2 = 200.
    expect(fitScroll({ w: 2000, h: 1000 }, { w: 800, h: 600 }, 1)).toEqual({ scrollLeft: 600, scrollTop: 200 });
  });
});

describe("uxMath — matchesQuery", () => {
  const node = { hash: "3aebf1885b7d", message: "add rate limiting", author: "Jane Doe", branchLabel: "billing" };

  it("empty query always matches", () => {
    expect(matchesQuery("", node)).toBe(true);
    expect(matchesQuery("   ", node)).toBe(true);
  });

  it("matches a hash PREFIX, case-insensitive", () => {
    expect(matchesQuery("3aeb", node)).toBe(true);
    expect(matchesQuery("3AEB", node)).toBe(true);
    expect(matchesQuery("f188", node)).toBe(false); // not a prefix
  });

  it("matches a message substring, case-insensitive", () => {
    expect(matchesQuery("rate limit", node)).toBe(true);
    expect(matchesQuery("RATE LIMIT", node)).toBe(true);
  });

  it("matches an author substring, case-insensitive", () => {
    expect(matchesQuery("jane", node)).toBe(true);
    expect(matchesQuery("doe", node)).toBe(true);
  });

  it("matches a branchLabel substring, case-insensitive", () => {
    expect(matchesQuery("bill", node)).toBe(true);
  });

  it("null author/branchLabel are skipped, not thrown on", () => {
    const bare = { hash: "abc123", message: "root", author: null, branchLabel: null };
    expect(matchesQuery("abc", bare)).toBe(true);
    expect(matchesQuery("nope", bare)).toBe(false);
  });

  it("no match returns false", () => {
    expect(matchesQuery("zzz-nope", node)).toBe(false);
  });
});

describe("uxMath — nextMatchIndex / prevMatchIndex (search cycle)", () => {
  // Task 19 review fix (finding 3): the first Shift+Enter after a query change/set (index === -1)
  // must land on the LAST match, not one short of it.
  it("first Enter (index -1) always lands on the first match (0)", () => {
    expect(nextMatchIndex(-1, 3)).toBe(0);
    expect(nextMatchIndex(-1, 1)).toBe(0);
  });

  it("first Shift+Enter (index -1) always lands on the LAST match, not one short of it", () => {
    expect(prevMatchIndex(-1, 3)).toBe(2); // regression case from the bug report: "3 of 3"
    expect(prevMatchIndex(-1, 1)).toBe(0);
    expect(prevMatchIndex(-1, 5)).toBe(4);
  });

  it("nextMatchIndex wraps forward from a real index", () => {
    expect(nextMatchIndex(0, 3)).toBe(1);
    expect(nextMatchIndex(1, 3)).toBe(2);
    expect(nextMatchIndex(2, 3)).toBe(0); // wraps
  });

  it("prevMatchIndex wraps backward from a real index", () => {
    expect(prevMatchIndex(2, 3)).toBe(1);
    expect(prevMatchIndex(1, 3)).toBe(0);
    expect(prevMatchIndex(0, 3)).toBe(2); // wraps
  });

  it("next then prev (or vice versa) from a fresh -1 returns to the same match for a single-match set", () => {
    expect(nextMatchIndex(-1, 1)).toBe(0);
    expect(prevMatchIndex(-1, 1)).toBe(0);
  });
});

describe("uxMath — computeAncestorSet", () => {
  const nodes = [
    { id: "a", downRevisions: ["b"] },
    { id: "b", downRevisions: ["c", "d"] }, // merge: two parents
    { id: "c", downRevisions: ["e"] },
    { id: "d", downRevisions: ["e"] },
    { id: "e", downRevisions: [] },
    { id: "unrelated", downRevisions: [] },
  ];

  it("includes the hovered node itself plus every transitive ancestor", () => {
    const set = computeAncestorSet("a", nodes);
    expect(set).toEqual(new Set(["a", "b", "c", "d", "e"]));
  });

  it("a root node's ancestor set is just itself", () => {
    expect(computeAncestorSet("e", nodes)).toEqual(new Set(["e"]));
  });

  it("unrelated nodes are excluded", () => {
    const set = computeAncestorSet("a", nodes);
    expect(set.has("unrelated")).toBe(false);
  });

  it("a downRevision pointing at an id with no node (e.g. a ghost) is still included", () => {
    const withGhost = [{ id: "child", downRevisions: ["missing-ghost"] }];
    const set = computeAncestorSet("child", withGhost);
    expect(set).toEqual(new Set(["child", "missing-ghost"]));
  });

  it("is cycle-safe: a corrupt down_revision cycle terminates instead of looping forever", () => {
    const cyclic = [
      { id: "x", downRevisions: ["y"] },
      { id: "y", downRevisions: ["x"] },
    ];
    const set = computeAncestorSet("x", cyclic);
    expect(set).toEqual(new Set(["x", "y"]));
  });

  it("unknown startId with no matching node still returns a singleton set", () => {
    expect(computeAncestorSet("ghost-only", nodes)).toEqual(new Set(["ghost-only"]));
  });
});

describe("uxMath — verticalRowDelta", () => {
  it("newest-top: row increases downward, so ArrowDown -> +1, ArrowUp -> -1", () => {
    expect(verticalRowDelta("down", "newest-top")).toBe(1);
    expect(verticalRowDelta("up", "newest-top")).toBe(-1);
  });

  it("newest-bottom: the layout is mirrored, so the row deltas flip", () => {
    expect(verticalRowDelta("down", "newest-bottom")).toBe(-1);
    expect(verticalRowDelta("up", "newest-bottom")).toBe(1);
  });
});

describe("uxMath — findRowNeighbor / findLaneNeighbor", () => {
  // A small 2-lane grid:
  //   row 0: lane0=A lane1=B
  //   row 1: lane0=C            (lane 1 empty this row)
  //   row 2: lane0=D lane1=E
  const nodes = [
    { id: "A", lane: 0, row: 0 },
    { id: "B", lane: 1, row: 0 },
    { id: "C", lane: 0, row: 1 },
    { id: "D", lane: 0, row: 2 },
    { id: "E", lane: 1, row: 2 },
  ];

  it("findRowNeighbor prefers the same lane in the adjacent row", () => {
    expect(findRowNeighbor(nodes, nodes[0], 1)).toBe("C"); // A (lane0,row0) -> down -> C (lane0,row1)
  });

  it("findRowNeighbor falls back to the nearest lane when the adjacent row has no same-lane node", () => {
    // B is lane1,row0; row1 only has lane0 (C) -> falls back to C.
    expect(findRowNeighbor(nodes, nodes[1], 1)).toBe("C");
  });

  it("findRowNeighbor skips an empty row and lands on the next occupied one", () => {
    // C (lane0,row1) moving down: row2 has both D(lane0) and E(lane1) -> same-lane D wins.
    expect(findRowNeighbor(nodes, nodes[2], 1)).toBe("D");
  });

  it("findRowNeighbor returns null at the edge (no row in that direction)", () => {
    expect(findRowNeighbor(nodes, nodes[0], -1)).toBeNull();
    expect(findRowNeighbor(nodes, nodes[3], 1)).toBeNull();
  });

  it("findLaneNeighbor prefers the same row in the adjacent lane", () => {
    expect(findLaneNeighbor(nodes, nodes[0], 1)).toBe("B"); // A -> right -> B (same row 0)
  });

  it("findLaneNeighbor falls back to the nearest row when the adjacent lane has no same-row node", () => {
    // C is lane0,row1; lane1 has B(row0) and E(row2) — both equally 1 row away, first-found wins
    // deterministically (array order: B before E).
    expect(findLaneNeighbor(nodes, nodes[2], 1)).toBe("B");
  });

  it("findLaneNeighbor returns null at the edge (no lane in that direction)", () => {
    expect(findLaneNeighbor(nodes, nodes[0], -1)).toBeNull();
    expect(findLaneNeighbor(nodes, nodes[1], 1)).toBeNull();
  });

  it("a fully isolated node (single-node graph) has no neighbors in any direction", () => {
    const solo = [{ id: "only", lane: 0, row: 0 }];
    expect(findRowNeighbor(solo, solo[0], 1)).toBeNull();
    expect(findRowNeighbor(solo, solo[0], -1)).toBeNull();
    expect(findLaneNeighbor(solo, solo[0], 1)).toBeNull();
    expect(findLaneNeighbor(solo, solo[0], -1)).toBeNull();
  });
});

describe("uxMath — arrowKeyTarget (Task H: axis-aware arrow-key mapping)", () => {
  it("vertical: Up/Down are along-chain (row), matching verticalRowDelta", () => {
    expect(arrowKeyTarget("ArrowDown", "vertical", "newest-top")).toEqual({ kind: "row", delta: 1 });
    expect(arrowKeyTarget("ArrowUp", "vertical", "newest-top")).toEqual({ kind: "row", delta: -1 });
    expect(arrowKeyTarget("ArrowDown", "vertical", "newest-bottom")).toEqual({ kind: "row", delta: -1 });
    expect(arrowKeyTarget("ArrowUp", "vertical", "newest-bottom")).toEqual({ kind: "row", delta: 1 });
  });

  it("vertical: Left/Right are across-lane, order-independent", () => {
    expect(arrowKeyTarget("ArrowRight", "vertical", "newest-top")).toEqual({ kind: "lane", delta: 1 });
    expect(arrowKeyTarget("ArrowLeft", "vertical", "newest-top")).toEqual({ kind: "lane", delta: -1 });
    expect(arrowKeyTarget("ArrowRight", "vertical", "newest-bottom")).toEqual({ kind: "lane", delta: 1 });
    expect(arrowKeyTarget("ArrowLeft", "vertical", "newest-bottom")).toEqual({ kind: "lane", delta: -1 });
  });

  it("horizontal: Left/Right are along-chain (row) — the inverse of vertical", () => {
    // newest-top: x increases with row directly (nodeXY's effRow = row, no flip) — same shape as
    // vertical's "row increases downward" under newest-top, so ArrowRight/Left reuse
    // verticalRowDelta("down"/"up", order) unchanged (see uxMath.ts's arrowKeyTarget doc comment).
    expect(arrowKeyTarget("ArrowRight", "horizontal", "newest-top")).toEqual({ kind: "row", delta: 1 });
    expect(arrowKeyTarget("ArrowLeft", "horizontal", "newest-top")).toEqual({ kind: "row", delta: -1 });
    expect(arrowKeyTarget("ArrowRight", "horizontal", "newest-bottom")).toEqual({ kind: "row", delta: -1 });
    expect(arrowKeyTarget("ArrowLeft", "horizontal", "newest-bottom")).toEqual({ kind: "row", delta: 1 });
  });

  it("horizontal: Up/Down are across-lane (lane increases downward), order-independent", () => {
    expect(arrowKeyTarget("ArrowDown", "horizontal", "newest-top")).toEqual({ kind: "lane", delta: 1 });
    expect(arrowKeyTarget("ArrowUp", "horizontal", "newest-top")).toEqual({ kind: "lane", delta: -1 });
    expect(arrowKeyTarget("ArrowDown", "horizontal", "newest-bottom")).toEqual({ kind: "lane", delta: 1 });
    expect(arrowKeyTarget("ArrowUp", "horizontal", "newest-bottom")).toEqual({ kind: "lane", delta: -1 });
  });
});
