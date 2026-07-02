/**
 * Deterministic (lane, row) assignment for an Alembic migration DAG.
 *
 * Same purity rule as parser.ts / graph.ts: no `node`, `vscode`, or DOM APIs, so this file
 * typechecks under both the extension-host tsconfig and the webview tsconfig. The output
 * (`GraphLayout`) is fully denormalized — the webview renderer only maps (lane, row) to pixels
 * and never needs to consult the graph again.
 */
import type { GraphLayout, LayoutEdge, LayoutNode, MigrationGraph } from "./types";

export interface LayoutOptions {
  /** Minimum linear-run length (at the root end) to collapse. */
  collapseThreshold: number;
  expandCollapsed: boolean;
  /** From computeAppliedSet; null = DB state unknown. */
  appliedSet: Set<string> | null;
  currentIds: string[];
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const COLLAPSE_ID = "collapse";

/** `createDate` sort key: null (missing) sorts oldest, i.e. before every real date string. */
function dateKey(createDate: string | null): string {
  return createDate ?? "";
}

/** `createDate` -> "MMM DD" from its `YYYY-MM-DD` prefix; null (or unparseable) -> null. */
function formatDateLabel(createDate: string | null): string | null {
  if (createDate === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(createDate);
  if (m === null) return null;
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return `${MONTHS[monthIndex]} ${m[3]}`;
}

export function layoutGraph(graph: MigrationGraph, opts: LayoutOptions): GraphLayout {
  // Every entity that occupies a row: real revision ids plus ghost (missing-parent) ids. Both are
  // keys of `graph.children` (buildGraph seeds an empty array for real nodes and a key per ghost).
  const entityIds = Object.keys(graph.children);
  const isGhost = (id: string): boolean => !(id in graph.nodes);
  const parentsOf = (id: string): string[] => (id in graph.nodes ? graph.nodes[id].downRevisions : []);

  /** Pop priority: a node's own createDate; a ghost borrows its NEWEST child's createDate. */
  const priorityOf = (id: string): string => {
    if (id in graph.nodes) return dateKey(graph.nodes[id].createDate);
    let newest = "";
    for (const childId of graph.children[id]) {
      const key = dateKey(graph.nodes[childId]?.createDate ?? null);
      if (key > newest) newest = key;
    }
    return newest;
  };

  const rowOrder = assignRows(graph, entityIds, isGhost, parentsOf, priorityOf);
  const { laneByRow, laneCountAtRow } = assignLanes(graph, rowOrder, isGhost, parentsOf);

  const laneById = new Map<string, number>();
  for (let row = 0; row < rowOrder.length; row++) laneById.set(rowOrder[row], laneByRow[row]);

  // Decorate every placed entity in row order.
  let nodes: LayoutNode[] = rowOrder.map((id, row) => decorate(id, laneByRow[row], row, graph, opts, isGhost));

  // Edges: one per child->parent link (including broken links into ghosts), colored by the parent.
  let edges: LayoutEdge[] = [];
  for (const id of entityIds) {
    if (isGhost(id)) continue; // ghosts have no downRevisions of their own
    for (const parentId of graph.nodes[id].downRevisions) {
      edges.push({
        from: parentId,
        to: id,
        kind: isGhost(parentId) ? "broken" : "normal",
        colorLane: laneById.get(parentId) ?? 0,
      });
    }
  }

  let collapsed: { count: number } | null = null;
  if (!opts.expandCollapsed) {
    const run = collapseRun(graph, rowOrder, laneCountAtRow, opts);
    if (run.length >= opts.collapseThreshold) {
      const result = applyCollapse(nodes, edges, run, laneById);
      nodes = result.nodes;
      edges = result.edges;
      collapsed = { count: result.count };
    }
  }

  // Final row map (dense 0..N-1 whether or not a collapse compacted it) drives edge ordering.
  const rowById = new Map<string, number>();
  for (const n of nodes) rowById.set(n.id, n.row);
  edges.sort((a, b) => {
    const ra = rowById.get(a.to) ?? 0;
    const rb = rowById.get(b.to) ?? 0;
    if (ra !== rb) return ra - rb;
    return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
  });

  let laneCount = 0;
  let rowCount = 0;
  for (const n of nodes) {
    if (n.lane + 1 > laneCount) laneCount = n.lane + 1;
    if (n.row + 1 > rowCount) rowCount = n.row + 1;
  }

  return { nodes, edges, laneCount, rowCount, collapsed };
}

/**
 * Rows via chronology-aware reverse Kahn on the reversed DAG: a node is ready once all its children
 * are placed; among ready nodes we always pop the newest (by priority date, ghosts-before-real,
 * then id asc). Cycle-safe: if the ready set empties with entities remaining, force the best
 * remaining entity so the loop always terminates. Returns entity ids in row order (index = row).
 */
function assignRows(
  graph: MigrationGraph,
  entityIds: string[],
  isGhost: (id: string) => boolean,
  parentsOf: (id: string) => string[],
  priorityOf: (id: string) => string,
): string[] {
  /** True if `a` should pop before `b`. */
  const popsBefore = (a: string, b: string): boolean => {
    const pa = priorityOf(a);
    const pb = priorityOf(b);
    if (pa !== pb) return pa > pb; // newest first
    const ga = isGhost(a);
    const gb = isGhost(b);
    if (ga !== gb) return ga; // ghost before real revision
    return a < b; // id ascending
  };

  const pickBest = (pool: Iterable<string>): string => {
    let best: string | null = null;
    for (const id of pool) {
      if (best === null || popsBefore(id, best)) best = id;
    }
    return best as string;
  };

  const unplacedChildCount = new Map<string, number>();
  for (const id of entityIds) unplacedChildCount.set(id, graph.children[id].length);

  const unplaced = new Set<string>(entityIds);
  const ready: string[] = entityIds.filter((id) => graph.children[id].length === 0);

  const rowOrder: string[] = [];
  while (unplaced.size > 0) {
    // Cycle fallback: no node is ready but entities remain -> force the best remaining one.
    const chosen = ready.length > 0 ? pickBest(ready) : pickBest(unplaced);

    rowOrder.push(chosen);
    unplaced.delete(chosen);
    const readyIdx = ready.indexOf(chosen);
    if (readyIdx >= 0) ready.splice(readyIdx, 1);

    // Placing `chosen` may make its parents (which have it as a child) ready.
    for (const parentId of parentsOf(chosen)) {
      const remaining = unplacedChildCount.get(parentId);
      if (remaining === undefined) continue;
      const next = remaining - 1;
      unplacedChildCount.set(parentId, next);
      if (next === 0 && unplaced.has(parentId) && ready.indexOf(parentId) < 0) {
        ready.push(parentId);
      }
    }
  }
  return rowOrder;
}

/**
 * Git-graph column assignment over the fixed row order. Lane 0 is pre-seeded for the trunk head so
 * the trunk chain keeps lane 0 even when another head pops first. Returns each row's lane and the
 * number of active lanes after processing that row (consumed by collapse).
 */
function assignLanes(
  graph: MigrationGraph,
  rowOrder: string[],
  isGhost: (id: string) => boolean,
  parentsOf: (id: string) => string[],
): { laneByRow: number[]; laneCountAtRow: number[] } {
  const trunkHeadId = pickTrunkHead(graph);

  const activeLanes: (string | null)[] = [];
  if (trunkHeadId !== null) activeLanes.push(trunkHeadId); // pre-seed lane 0

  const firstNull = (): number => activeLanes.findIndex((slot) => slot === null);
  const placeIntoLane = (id: string): void => {
    const slot = firstNull();
    if (slot === -1) activeLanes.push(id);
    else activeLanes[slot] = id;
  };

  const laneByRow: number[] = [];
  const laneCountAtRow: number[] = [];

  for (let row = 0; row < rowOrder.length; row++) {
    const id = rowOrder[row];

    const claiming: number[] = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === id) claiming.push(i);
    }

    let lane: number;
    if (claiming.length === 0) {
      lane = firstNull();
      if (lane === -1) {
        lane = activeLanes.length;
        activeLanes.push(null);
      }
    } else {
      lane = claiming[0]; // min, since claiming is built ascending
      for (const i of claiming) {
        if (i !== lane) activeLanes[i] = null; // free the merged-away lanes
      }
    }

    const parents = parentsOf(id);
    if (parents.length === 0) {
      // root or ghost: nothing continues in this lane
      activeLanes[lane] = null;
    } else {
      activeLanes[lane] = parents[0];
      for (let k = 1; k < parents.length; k++) placeIntoLane(parents[k]); // merge: open lanes
    }

    laneByRow[row] = lane;
    laneCountAtRow[row] = activeLanes.reduce((count, slot) => (slot !== null ? count + 1 : count), 0);
  }

  return { laneByRow, laneCountAtRow };
}

/**
 * Picks the trunk head (owner of lane 0). Preference is layered on each head's ancestry (transitive
 * downRevisions, cycle-safe, including the head itself): first avoid ghost ancestry, then avoid
 * branchLabels ancestry, then newest createDate, then id ascending. With no clean head this still
 * prefers a labeled-but-whole chain over a ghost-tainted one (fixture: 4bfc over the newer 5c0d).
 */
function pickTrunkHead(graph: MigrationGraph): string | null {
  const flagsOf = (headId: string): { ghost: boolean; labeled: boolean } => {
    const visited = new Set<string>();
    const stack = [headId];
    let ghost = false;
    let labeled = false;
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (visited.has(id)) continue;
      visited.add(id);
      if (!(id in graph.nodes)) {
        ghost = true;
        continue;
      }
      const node = graph.nodes[id];
      if (node.branchLabels.length > 0) labeled = true;
      for (const parentId of node.downRevisions) {
        if (!visited.has(parentId)) stack.push(parentId);
      }
    }
    return { ghost, labeled };
  };

  let bestId: string | null = null;
  let bestFlags: { ghost: boolean; labeled: boolean } | null = null;
  for (const headId of graph.heads) {
    const flags = flagsOf(headId);
    if (bestId === null || bestFlags === null) {
      bestId = headId;
      bestFlags = flags;
      continue;
    }
    if (flags.ghost !== bestFlags.ghost) {
      if (!flags.ghost) {
        bestId = headId;
        bestFlags = flags;
      }
      continue;
    }
    if (flags.labeled !== bestFlags.labeled) {
      if (!flags.labeled) {
        bestId = headId;
        bestFlags = flags;
      }
      continue;
    }
    const dh = dateKey(graph.nodes[headId].createDate);
    const db = dateKey(graph.nodes[bestId].createDate);
    if (dh !== db) {
      if (dh > db) {
        bestId = headId;
        bestFlags = flags;
      }
      continue;
    }
    if (headId < bestId) {
      bestId = headId;
      bestFlags = flags;
    }
  }
  return bestId;
}

/** Builds a LayoutNode with fully denormalized display payload. */
function decorate(
  id: string,
  lane: number,
  row: number,
  graph: MigrationGraph,
  opts: LayoutOptions,
  isGhost: (id: string) => boolean,
): LayoutNode {
  const isCurrent = opts.currentIds.includes(id);
  if (isGhost(id)) {
    return {
      id,
      kind: "ghost",
      lane,
      row,
      hash: id,
      message: "",
      author: null,
      dateLabel: null,
      branchLabel: null,
      isHead: false,
      isMerge: false,
      isBroken: false,
      isCurrent,
      applied: null,
      filePath: null,
      downRevisions: [],
    };
  }

  const node = graph.nodes[id];
  return {
    id,
    kind: "revision",
    lane,
    row,
    hash: id,
    message: node.message,
    author: null,
    dateLabel: formatDateLabel(node.createDate),
    branchLabel: node.branchLabels[0] ?? null,
    isHead: node.isHead,
    isMerge: node.isMerge,
    isBroken: node.isBroken,
    isCurrent,
    applied: opts.appliedSet ? opts.appliedSet.has(id) : null,
    filePath: node.filePath,
    downRevisions: node.downRevisions,
  };
}

/**
 * The maximal linear run at the ROOT end (highest row) walking toward newer rows. Every node must
 * be a plain revision (exactly 1 child, <=1 parent, not head/merge/broken/ghost/current) sitting on
 * a solo trunk, and the whole run must share one applied value. Returned oldest-first (root end
 * first); the newest member is the anchor kept visible.
 */
function collapseRun(
  graph: MigrationGraph,
  rowOrder: string[],
  laneCountAtRow: number[],
  opts: LayoutOptions,
): string[] {
  const appliedOf = (id: string): boolean | null => (opts.appliedSet ? opts.appliedSet.has(id) : null);

  const qualifies = (id: string, row: number): boolean => {
    if (!(id in graph.nodes)) return false; // ghost
    const node = graph.nodes[id];
    if (node.isHead || node.isMerge || node.isBroken) return false;
    if (opts.currentIds.includes(id)) return false;
    if (graph.children[id].length !== 1) return false;
    if (node.downRevisions.length > 1) return false;
    // Solo trunk at this row. A freed root/ghost row records 0 active lanes, which still counts as
    // linear (the fixture's root 8f2a must be collapsible), hence <= 1 rather than a strict == 1.
    if (laneCountAtRow[row] > 1) return false;
    return true;
  };

  const run: string[] = [];
  for (let row = rowOrder.length - 1; row >= 0; row--) {
    const id = rowOrder[row];
    if (!qualifies(id, row)) break;
    if (run.length > 0 && appliedOf(id) !== appliedOf(run[0])) break; // applied-uniform
    run.push(id);
  }
  return run;
}

/**
 * Replaces every run member except the anchor (newest) with one collapse node inserted right after
 * the anchor, then re-densifies rows 0..N-1. Edges touching replaced nodes are dropped and a single
 * collapse->anchor edge is added.
 */
function applyCollapse(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  run: string[],
  laneById: Map<string, number>,
): { nodes: LayoutNode[]; edges: LayoutEdge[]; count: number } {
  const anchorId = run[run.length - 1]; // newest member
  const anchorLane = laneById.get(anchorId) ?? 0;
  const collapsedIds = run.slice(0, run.length - 1); // oldest-first
  const replaced = new Set(collapsedIds);

  const collapseNode: LayoutNode = {
    id: COLLAPSE_ID,
    kind: "collapse",
    lane: anchorLane,
    row: 0, // reassigned during densification below
    hash: COLLAPSE_ID,
    message: "",
    author: null,
    dateLabel: null,
    branchLabel: null,
    isHead: false,
    isMerge: false,
    isBroken: false,
    isCurrent: false,
    applied: null,
    filePath: null,
    downRevisions: [],
    collapsedCount: collapsedIds.length,
    collapsedIds,
  };

  const keptNodes = nodes.filter((n) => !replaced.has(n.id));
  const anchorIndex = keptNodes.findIndex((n) => n.id === anchorId);
  keptNodes.splice(anchorIndex + 1, 0, collapseNode);
  keptNodes.forEach((n, index) => {
    n.row = index;
  });

  const keptEdges = edges.filter((e) => !replaced.has(e.from) && !replaced.has(e.to));
  keptEdges.push({ from: COLLAPSE_ID, to: anchorId, kind: "collapse", colorLane: anchorLane });

  return { nodes: keptNodes, edges: keptEdges, count: collapsedIds.length };
}
