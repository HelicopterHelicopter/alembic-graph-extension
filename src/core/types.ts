/** Result of statically parsing one versions/*.py file. */
export interface ParsedRevision {
  revision: string;
  /** Parent revision ids; [] for a root (down_revision = None). */
  downRevisions: string[];
  branchLabels: string[];
  /** First line of the module docstring; "" if absent. */
  message: string;
  /** Raw value of the docstring "Create Date:" line; null if absent. */
  createDate: string | null;
  filePath: string;
  /** 0-based line numbers for diagnostics; null if not found. */
  revisionLine: number;
  downRevisionLine: number | null;
}

export type ProblemKind = "broken-down-revision" | "duplicate-revision-id";
export interface Problem {
  kind: ProblemKind;
  /** Human-readable one-liner for sidebar/toasts. */
  summary: string;
  /** Revision id(s) involved. broken: [childId, missingId]. duplicate: [id]. */
  revisionIds: string[];
  /** File(s) to point diagnostics at, with 0-based line. */
  locations: { filePath: string; line: number }[];
}

export interface RevisionNode extends ParsedRevision {
  isHead: boolean;
  isMerge: boolean;   // >= 2 downRevisions
  isRoot: boolean;    // 0 downRevisions
  isBroken: boolean;  // at least one downRevision has no file
}

export interface MigrationGraph {
  /** Keyed by revision id. */
  nodes: Record<string, RevisionNode>;
  /** Missing-parent placeholders. id = the missing revision id. */
  ghosts: { id: string; childIds: string[] }[];
  /** childIds per parent id (includes ghost ids as keys). */
  children: Record<string, string[]>;
  heads: string[];   // deterministic order
  roots: string[];
  problems: Problem[];
}

export type LayoutNodeKind = "revision" | "ghost" | "collapse";
export interface LayoutNode {
  id: string;                 // revision id; ghost: missing id; collapse: "collapse"
  kind: LayoutNodeKind;
  lane: number;
  row: number;                // 0 = newest; renderer flips for orientation
  // display payload (denormalized so the webview never needs the graph):
  hash: string;               // full revision id (webview truncates)
  message: string;
  author: string | null;      // enriched async from git; null until known
  dateLabel: string | null;   // e.g. "May 03" — host formats
  branchLabel: string | null;
  isHead: boolean;
  isMerge: boolean;
  isBroken: boolean;
  isCurrent: boolean;
  /** null = DB state unknown (dbReachable false); boolean otherwise. */
  applied: boolean | null;
  filePath: string | null;    // null for ghost/collapse
  downRevisions: string[];
  /** collapse only */
  collapsedCount?: number;
  collapsedIds?: string[];
}

export type LayoutEdgeKind = "normal" | "broken" | "collapse";
export interface LayoutEdge {
  /** Parent (older) node id — edge is drawn parent→child. */
  from: string;
  to: string;
  kind: LayoutEdgeKind;
  /** Lane index whose color the edge takes (parent's lane). */
  colorLane: number;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  laneCount: number;
  rowCount: number;
  /** Present when a collapse node replaced a run. */
  collapsed: { count: number } | null;
}
