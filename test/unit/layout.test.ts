import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseRevisionSource } from "../../src/core/parser";
import { buildGraph } from "../../src/core/graph";
import { layoutGraph, type LayoutOptions } from "../../src/core/layout";
import type { GraphLayout, LayoutNode, ParsedRevision } from "../../src/core/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKEN_VERSIONS_DIR = path.join(here, "../../fixtures/broken-project/alembic/versions");

/** ParsedRevision literal with sane defaults so each test only specifies what matters. */
function mkRevision(opts: {
  revision: string;
  downRevisions?: string[];
  branchLabels?: string[];
  message?: string;
  createDate?: string | null;
  filePath?: string;
  revisionLine?: number;
  downRevisionLine?: number | null;
}): ParsedRevision {
  return {
    revision: opts.revision,
    downRevisions: opts.downRevisions ?? [],
    branchLabels: opts.branchLabels ?? [],
    message: opts.message ?? "",
    createDate: opts.createDate ?? null,
    filePath: opts.filePath ?? `${opts.revision}.py`,
    revisionLine: opts.revisionLine ?? 0,
    downRevisionLine: opts.downRevisionLine === undefined ? 1 : opts.downRevisionLine,
  };
}

/** A YYYY-MM-DD prefix at 10:00 — keeps dates readable and parser-shaped. */
function d(day: number): string {
  return `2026-05-${String(day).padStart(2, "0")} 10:00:00.000000`;
}

function mkOpts(overrides: Partial<LayoutOptions> = {}): LayoutOptions {
  return {
    collapseThreshold: 20,
    expandCollapsed: false,
    appliedSet: null,
    currentIds: [],
    ...overrides,
  };
}

function byId(layout: GraphLayout): Map<string, LayoutNode> {
  return new Map(layout.nodes.map((n) => [n.id, n]));
}

describe("layoutGraph — rows & lanes", () => {
  it("1. linear chain: all lane 0, rows newest-first, 3 normal edges, laneCount 1", () => {
    const n1 = mkRevision({ revision: "n1", createDate: d(1) });
    const n2 = mkRevision({ revision: "n2", downRevisions: ["n1"], createDate: d(2) });
    const n3 = mkRevision({ revision: "n3", downRevisions: ["n2"], createDate: d(3) });
    const n4 = mkRevision({ revision: "n4", downRevisions: ["n3"], createDate: d(4) });
    const layout = layoutGraph(buildGraph([n1, n2, n3, n4]), mkOpts());

    const m = byId(layout);
    expect(m.get("n4")).toMatchObject({ row: 0, lane: 0 });
    expect(m.get("n3")).toMatchObject({ row: 1, lane: 0 });
    expect(m.get("n2")).toMatchObject({ row: 2, lane: 0 });
    expect(m.get("n1")).toMatchObject({ row: 3, lane: 0 });
    expect(layout.laneCount).toBe(1);
    expect(layout.rowCount).toBe(4);
    expect(layout.collapsed).toBeNull();
    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.every((e) => e.kind === "normal")).toBe(true);
    // parent->child, ordered by child row asc
    expect(layout.edges).toEqual([
      { from: "n3", to: "n4", kind: "normal", colorLane: 0 },
      { from: "n2", to: "n3", kind: "normal", colorLane: 0 },
      { from: "n1", to: "n2", kind: "normal", colorLane: 0 },
    ]);
  });

  it("2. trunk selection: clean head takes lane 0 even though the labeled head is newer", () => {
    const r = mkRevision({ revision: "r", createDate: d(1) });
    const y1 = mkRevision({ revision: "y1", downRevisions: ["r"], createDate: d(2) });
    const yHead = mkRevision({ revision: "yHead", downRevisions: ["y1"], createDate: d(5) });
    const x1 = mkRevision({ revision: "x1", downRevisions: ["r"], branchLabels: ["feat"], createDate: d(3) });
    const xHead = mkRevision({ revision: "xHead", downRevisions: ["x1"], createDate: d(6) });
    const layout = layoutGraph(buildGraph([r, y1, yHead, x1, xHead]), mkOpts());

    const m = byId(layout);
    expect(m.get("yHead")!.lane).toBe(0); // clean ancestry -> trunk
    expect(m.get("xHead")!.lane).toBe(1); // newer, but its ancestry passes through a branchLabels node
    expect(layout.laneCount).toBe(2);
  });

  it("3. trunk fallback: both heads have labeled ancestry -> newest-date head takes lane 0", () => {
    const r = mkRevision({ revision: "r", createDate: d(1) });
    const a1 = mkRevision({ revision: "a1", downRevisions: ["r"], branchLabels: ["a"], createDate: d(2) });
    const aHead = mkRevision({ revision: "aHead", downRevisions: ["a1"], createDate: d(5) });
    const b1 = mkRevision({ revision: "b1", downRevisions: ["r"], branchLabels: ["b"], createDate: d(3) });
    const bHead = mkRevision({ revision: "bHead", downRevisions: ["b1"], createDate: d(4) });
    const layout = layoutGraph(buildGraph([r, a1, aHead, b1, bHead]), mkOpts());

    const m = byId(layout);
    expect(m.get("aHead")!.lane).toBe(0); // newest labeled head wins the trunk
    expect(m.get("bHead")!.lane).toBe(1);
  });

  it("4. merge fan-out & rejoin: merge lane 0, second parent opens lane 1, divergence frees lane 1", () => {
    const r = mkRevision({ revision: "r", createDate: d(1) });
    const a = mkRevision({ revision: "a", downRevisions: ["r"], createDate: d(2) });
    const b = mkRevision({ revision: "b", downRevisions: ["r"], createDate: d(3) });
    const mrg = mkRevision({ revision: "mrg", downRevisions: ["a", "b"], createDate: d(4) });
    const h = mkRevision({ revision: "h", downRevisions: ["mrg"], createDate: d(5) });
    const layout = layoutGraph(buildGraph([r, a, b, mrg, h]), mkOpts());

    const m = byId(layout);
    expect(m.get("h")!.lane).toBe(0);
    expect(m.get("mrg")!.lane).toBe(0); // merge stays on trunk
    expect(m.get("b")!.lane).toBe(1); // second parent opens lane 1
    expect(m.get("a")!.lane).toBe(0); // first parent continues trunk
    expect(m.get("r")!.lane).toBe(0); // divergence (2 claimants) returns to lane 0
    expect(layout.laneCount).toBe(2);
    expect(m.get("mrg")!.isMerge).toBe(true);
  });

  it("5. ghost placement: ghost pops right below its broken child in the same lane; edge is broken", () => {
    const r = mkRevision({ revision: "r", createDate: d(1) });
    const t = mkRevision({ revision: "t", downRevisions: ["r"], createDate: d(3) });
    const bk = mkRevision({ revision: "bk", downRevisions: ["deadbeef0000"], createDate: d(4) });
    const layout = layoutGraph(buildGraph([r, t, bk]), mkOpts());

    const m = byId(layout);
    const child = m.get("bk")!;
    const ghost = m.get("deadbeef0000")!;
    expect(ghost.kind).toBe("ghost");
    expect(child.lane).toBe(1); // broken head pushed off the trunk
    expect(ghost.lane).toBe(child.lane); // ghost inherits the child's lane
    expect(ghost.row).toBe(child.row + 1); // right below its child

    const brokenEdge = layout.edges.find((e) => e.to === "bk");
    expect(brokenEdge).toEqual({ from: "deadbeef0000", to: "bk", kind: "broken", colorLane: ghost.lane });
  });

  it("6. disconnected broken component interleaves chronologically between trunk rows", () => {
    const t0 = mkRevision({ revision: "t0", createDate: d(1) });
    const t1 = mkRevision({ revision: "t1", downRevisions: ["t0"], createDate: d(3) });
    const t2 = mkRevision({ revision: "t2", downRevisions: ["t1"], createDate: d(9) });
    const bk = mkRevision({ revision: "bk", downRevisions: ["deadbeef0000"], createDate: d(5) });
    const layout = layoutGraph(buildGraph([t0, t1, t2, bk]), mkOpts());

    const m = byId(layout);
    // dates: t2(9) bk(5) t1(3) t0(1); ghost pseudo-date = its child's = 5, pops right after bk
    expect(m.get("t2")!.row).toBe(0);
    expect(m.get("bk")!.row).toBe(1);
    expect(m.get("deadbeef0000")!.row).toBe(2);
    expect(m.get("t1")!.row).toBe(3);
    expect(m.get("t0")!.row).toBe(4);
  });
});

describe("layoutGraph — collapse", () => {
  function linear6(): ParsedRevision[] {
    return [
      mkRevision({ revision: "n0", createDate: d(1) }),
      mkRevision({ revision: "n1", downRevisions: ["n0"], createDate: d(2) }),
      mkRevision({ revision: "n2", downRevisions: ["n1"], createDate: d(3) }),
      mkRevision({ revision: "n3", downRevisions: ["n2"], createDate: d(4) }),
      mkRevision({ revision: "n4", downRevisions: ["n3"], createDate: d(5) }),
      mkRevision({ revision: "n5", downRevisions: ["n4"], createDate: d(6) }),
    ];
  }

  it("7. collapses a 6-node chain at threshold 3: head + anchor kept, one collapse node", () => {
    const layout = layoutGraph(buildGraph(linear6()), mkOpts({ collapseThreshold: 3 }));

    const m = byId(layout);
    // head n5 excluded; run = n0..n4 (5) -> anchor n4 kept, 4 collapsed
    expect(m.get("n5")).toMatchObject({ row: 0, lane: 0 });
    expect(m.get("n4")).toMatchObject({ row: 1, lane: 0 });
    const collapse = m.get("collapse")!;
    expect(collapse).toBeTruthy();
    expect(collapse.kind).toBe("collapse");
    expect(collapse.collapsedCount).toBe(4);
    expect(collapse.collapsedIds).toEqual(["n0", "n1", "n2", "n3"]); // oldest-first
    expect(collapse.lane).toBe(0);
    expect(collapse.row).toBe(2); // anchor.row + 1 after compaction
    expect(layout.rowCount).toBe(3);
    expect(layout.laneCount).toBe(1);
    expect(layout.collapsed).toEqual({ count: 4 });
    expect(layout.nodes).toHaveLength(3);
    // edges: n5<-n4 normal, n4<-collapse collapse
    expect(layout.edges).toEqual([
      { from: "n4", to: "n5", kind: "normal", colorLane: 0 },
      { from: "collapse", to: "n4", kind: "collapse", colorLane: 0 },
    ]);
  });

  it("7b. expandCollapsed disables collapse (all 6 nodes, collapsed null)", () => {
    const layout = layoutGraph(buildGraph(linear6()), mkOpts({ collapseThreshold: 3, expandCollapsed: true }));
    expect(layout.nodes).toHaveLength(6);
    expect(layout.collapsed).toBeNull();
    expect(byId(layout).has("collapse")).toBe(false);
  });

  it("7c. threshold above the run length disables collapse", () => {
    const layout = layoutGraph(buildGraph(linear6()), mkOpts({ collapseThreshold: 6 }));
    expect(layout.nodes).toHaveLength(6);
    expect(layout.collapsed).toBeNull();
  });

  it("8a. a current node mid-chain blocks collapse (root-end run falls below threshold)", () => {
    const layout = layoutGraph(buildGraph(linear6()), mkOpts({ collapseThreshold: 3, currentIds: ["n2"] }));
    // root-end run = {n0, n1} (n2 is current) -> length 2 < 3
    expect(layout.nodes).toHaveLength(6);
    expect(layout.collapsed).toBeNull();
  });

  it("8b. non-uniform applied blocks collapse", () => {
    const layout = layoutGraph(
      buildGraph(linear6()),
      mkOpts({ collapseThreshold: 3, appliedSet: new Set(["n0", "n1"]) }),
    );
    // root-end run breaks at n2 (applied changes true->false) -> {n0, n1} length 2 < 3
    expect(layout.nodes).toHaveLength(6);
    expect(layout.collapsed).toBeNull();
  });
});

describe("layoutGraph — decoration, determinism, cycles", () => {
  it("9. applied/current decoration; appliedSet null -> applied null everywhere", () => {
    const revs = [
      mkRevision({ revision: "n0", createDate: d(1) }),
      mkRevision({ revision: "n1", downRevisions: ["n0"], createDate: d(2) }),
      mkRevision({ revision: "n2", downRevisions: ["n1"], createDate: d(3) }),
    ];
    const withState = layoutGraph(
      buildGraph(revs),
      mkOpts({ appliedSet: new Set(["n0", "n1"]), currentIds: ["n1"] }),
    );
    const m = byId(withState);
    expect(m.get("n0")!.applied).toBe(true);
    expect(m.get("n1")!.applied).toBe(true);
    expect(m.get("n2")!.applied).toBe(false);
    expect(m.get("n1")!.isCurrent).toBe(true);
    expect(m.get("n0")!.isCurrent).toBe(false);
    expect(m.get("n2")!.isCurrent).toBe(false);
    expect(m.get("n0")!.dateLabel).toBe("May 01");

    const nullState = layoutGraph(buildGraph(revs), mkOpts());
    expect(nullState.nodes.every((n) => n.applied === null)).toBe(true);
  });

  it("10. determinism: shuffled input order -> deep-equal layout", () => {
    const r = mkRevision({ revision: "r", createDate: d(1) });
    const a = mkRevision({ revision: "a", downRevisions: ["r"], createDate: d(2) });
    const b = mkRevision({ revision: "b", downRevisions: ["r"], createDate: d(3) });
    const mrg = mkRevision({ revision: "mrg", downRevisions: ["a", "b"], createDate: d(4) });
    const bk = mkRevision({ revision: "bk", downRevisions: ["deadbeef0000"], createDate: d(5) });

    const l1 = layoutGraph(buildGraph([r, a, b, mrg, bk]), mkOpts());
    const l2 = layoutGraph(buildGraph([bk, mrg, b, a, r]), mkOpts());
    const l3 = layoutGraph(buildGraph([b, bk, r, mrg, a]), mkOpts());
    expect(l2).toEqual(l1);
    expect(l3).toEqual(l1);
  });

  it("11. cycle a<->b plus an independent chain: terminates, every node present exactly once", () => {
    const a = mkRevision({ revision: "a", downRevisions: ["b"], createDate: d(2) });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: d(1) });
    const c = mkRevision({ revision: "c", createDate: d(1) });
    const cd = mkRevision({ revision: "cd", downRevisions: ["c"], createDate: d(2) });
    const ce = mkRevision({ revision: "ce", downRevisions: ["cd"], createDate: d(3) });

    const layout = layoutGraph(buildGraph([a, b, c, cd, ce]), mkOpts());
    const ids = layout.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["a", "b", "c", "cd", "ce"]);
    expect(new Set(layout.nodes.map((n) => n.row)).size).toBe(5); // unique rows
  });
});

describe("layoutGraph — fixture snapshot", () => {
  const files = readdirSync(BROKEN_VERSIONS_DIR).filter((f) => f.endsWith(".py"));
  const revisions = files
    .map((file) => parseRevisionSource(readFileSync(path.join(BROKEN_VERSIONS_DIR, file), "utf8"), file))
    .filter((r): r is ParsedRevision => r !== null);

  it("12. lays out the broken fixture project exactly as hand-traced", () => {
    const layout = layoutGraph(buildGraph(revisions), mkOpts({ collapseThreshold: 20 }));

    const expected: Array<[string, number, number]> = [
      ["5c0d13aa7d9f", 0, 1],
      ["deadbeef0000", 1, 1],
      ["4bfc02996c8e", 2, 0],
      ["3aebf1885b7d", 3, 1],
      ["29dae0774a6c", 4, 0],
      ["07b8c8552e4a", 5, 1],
      ["18c9d9663f5b", 6, 0],
      ["f6a9b7241d3c", 7, 1],
      ["e5b8a600cc11", 8, 0],
      ["d4c7f5309b2e", 9, 0],
      ["c3d6e4b721a8", 10, 0],
      ["b2e5d3a10f66", 11, 0],
      ["8f2a1c9d4e07", 12, 0],
    ];
    const m = byId(layout);
    for (const [id, row, lane] of expected) {
      expect(m.get(id), `node ${id}`).toMatchObject({ row, lane });
    }
    expect(layout.nodes).toHaveLength(13);
    expect(layout.laneCount).toBe(2);
    expect(layout.rowCount).toBe(13);
    expect(layout.collapsed).toBeNull();

    expect(layout.edges).toHaveLength(12);
    expect(layout.edges.filter((e) => e.kind === "broken")).toEqual([
      { from: "deadbeef0000", to: "5c0d13aa7d9f", kind: "broken", colorLane: 1 },
    ]);
    expect(layout.edges.filter((e) => e.kind === "normal")).toHaveLength(11);
    // ghost carries the missing id, blank display payload
    expect(m.get("deadbeef0000")).toMatchObject({ kind: "ghost", message: "", dateLabel: null, applied: null });
  });

  it("13. fixture at threshold 3 collapses the root-end linear run", () => {
    const layout = layoutGraph(buildGraph(revisions), mkOpts({ collapseThreshold: 3 }));

    const m = byId(layout);
    // run = c3d6(10), b2e5(11), 8f2a(12); d4c7 excluded (2 children). anchor = c3d6.
    const collapse = m.get("collapse")!;
    expect(collapse.kind).toBe("collapse");
    expect(collapse.collapsedCount).toBe(2);
    expect(collapse.collapsedIds).toEqual(["8f2a1c9d4e07", "b2e5d3a10f66"]);
    expect(collapse.lane).toBe(0);
    expect(m.get("c3d6e4b721a8")).toMatchObject({ row: 10, lane: 0 }); // anchor kept
    expect(collapse.row).toBe(11); // anchor.row + 1
    expect(layout.rowCount).toBe(12);
    expect(layout.collapsed).toEqual({ count: 2 });
    expect(byId(layout).has("b2e5d3a10f66")).toBe(false);
    expect(byId(layout).has("8f2a1c9d4e07")).toBe(false);
    const collapseEdge = layout.edges.find((e) => e.kind === "collapse");
    expect(collapseEdge).toEqual({ from: "collapse", to: "c3d6e4b721a8", kind: "collapse", colorLane: 0 });
  });
});
