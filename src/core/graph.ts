/**
 * Pure DAG construction from parsed Alembic revisions.
 *
 * Same purity rule as parser.ts: no `node`/`vscode`/DOM APIs, so this file typechecks under
 * both the extension-host tsconfig and the webview tsconfig.
 */
import type { MigrationGraph, ParsedRevision, Problem, RevisionNode } from "./types";

/** `createDate` sort key: null (missing) sorts oldest, i.e. before every real date string. */
function dateKey(createDate: string | null): string {
  return createDate ?? "";
}

/** Ascending by (createDate, id) — used for children lists and roots. */
function compareOldestFirst(aId: string, aDate: string | null, bId: string, bDate: string | null): number {
  const da = dateKey(aDate);
  const db = dateKey(bDate);
  if (da !== db) return da < db ? -1 : 1;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** Descending by createDate, ascending id tie-break — used for heads (newest first). */
function compareNewestFirst(aId: string, aDate: string | null, bId: string, bDate: string | null): number {
  const da = dateKey(aDate);
  const db = dateKey(bDate);
  if (da !== db) return da > db ? -1 : 1;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * Resolves duplicate revision ids: groups the input by `revision`, keeps the group member whose
 * `filePath` sorts first (lexicographic, for determinism), and emits one `duplicate-revision-id`
 * Problem per group with >1 member (locations cover every member, in the same filePath order).
 */
function dedupeRevisions(revisions: ParsedRevision[]): { kept: ParsedRevision[]; problems: Problem[] } {
  const groups = new Map<string, ParsedRevision[]>();
  for (const rev of revisions) {
    const group = groups.get(rev.revision);
    if (group) {
      group.push(rev);
    } else {
      groups.set(rev.revision, [rev]);
    }
  }

  const kept: ParsedRevision[] = [];
  const problems: Problem[] = [];
  for (const [id, group] of groups) {
    const sorted = [...group].sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
    kept.push(sorted[0]);
    if (sorted.length > 1) {
      problems.push({
        kind: "duplicate-revision-id",
        summary: `duplicate revision id ${id} in ${sorted.length} files`,
        revisionIds: [id],
        locations: sorted.map((r) => ({ filePath: r.filePath, line: r.revisionLine })),
      });
    }
  }
  problems.sort((a, b) => (a.revisionIds[0] < b.revisionIds[0] ? -1 : a.revisionIds[0] > b.revisionIds[0] ? 1 : 0));

  return { kept, problems };
}

/** Builds a pure, deterministic migration DAG from parsed revisions. Cycle-safe (single pass, no traversal). */
export function buildGraph(revisions: ParsedRevision[]): MigrationGraph {
  const { kept, problems: duplicateProblems } = dedupeRevisions(revisions);

  const nodes: Record<string, RevisionNode> = {};
  for (const rev of kept) {
    nodes[rev.revision] = {
      ...rev,
      isHead: false, // filled in once the children index is known
      isMerge: rev.downRevisions.length >= 2,
      isRoot: rev.downRevisions.length === 0,
      isBroken: false, // filled in below, once ghost ids are known
    };
  }

  // children: every node id gets a key up front (empty array for heads); ghost ids get a key
  // implicitly as soon as a child is pushed under them.
  const children: Record<string, string[]> = {};
  for (const id of Object.keys(nodes)) children[id] = [];

  const brokenProblems: Problem[] = [];

  for (const rev of kept) {
    for (const parentId of rev.downRevisions) {
      if (!(parentId in nodes)) {
        nodes[rev.revision].isBroken = true;
        children[parentId] = children[parentId] ?? []; // ghost parent id, first time seen

        const line = rev.downRevisionLine ?? rev.revisionLine;
        brokenProblems.push({
          kind: "broken-down-revision",
          summary: `\`${rev.revision}\` revises missing revision \`${parentId}\``,
          revisionIds: [rev.revision, parentId],
          locations: [{ filePath: rev.filePath, line }],
        });
      }
      children[parentId].push(rev.revision);
    }
  }

  // Sort every children list oldest-first (createDate asc, id asc); children are always real
  // node ids (ghosts never have children of their own), so nodes[childId] always resolves.
  for (const parentId of Object.keys(children)) {
    children[parentId].sort((a, b) => compareOldestFirst(a, nodes[a].createDate, b, nodes[b].createDate));
  }

  // A ghost is any children-index key that isn't a real node — i.e. a missing parent id that
  // was referenced by at least one child's downRevisions.
  const ghosts = Object.keys(children)
    .filter((id) => !(id in nodes))
    .map((id) => ({ id, childIds: children[id] })) // already sorted above
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const nodeIds = Object.keys(nodes);
  for (const id of nodeIds) {
    nodes[id].isHead = children[id].length === 0;
  }

  const heads = nodeIds
    .filter((id) => children[id].length === 0)
    .sort((a, b) => compareNewestFirst(a, nodes[a].createDate, b, nodes[b].createDate));
  const roots = nodeIds
    .filter((id) => nodes[id].isRoot)
    .sort((a, b) => compareOldestFirst(a, nodes[a].createDate, b, nodes[b].createDate));

  brokenProblems.sort((a, b) => {
    const [childA, missingA] = a.revisionIds;
    const [childB, missingB] = b.revisionIds;
    if (childA !== childB) return childA < childB ? -1 : 1;
    return missingA < missingB ? -1 : missingA > missingB ? 1 : 0;
  });

  return {
    nodes,
    ghosts,
    children,
    heads,
    roots,
    problems: [...brokenProblems, ...duplicateProblems],
  };
}

/**
 * currentIds ∪ all ancestors reachable via downRevisions. Cycle-safe (visited-set guard).
 * Unknown ids (ghosts, typos) are ignored — they never enter the result and are never traversed.
 */
export function computeAppliedSet(graph: MigrationGraph, currentIds: string[]): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = currentIds.filter((id) => id in graph.nodes);

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = graph.nodes[id];
    for (const parentId of node.downRevisions) {
      if (parentId in graph.nodes && !visited.has(parentId)) {
        stack.push(parentId);
      }
    }
  }

  return visited;
}
