import type { GraphLayout, Problem } from "../core/types";

// ---------- shared payloads ----------

/**
 * One freeform topology edit the user asked for, in graph terms (never file terms) — planned by
 * `MigrationService.getTopologyPlan` into the concrete `down_revision` rewrites below.
 *
 * - `move-chain`: `nodeId` is re-parented to exactly `[targetId]`, and its descendants ride along
 *   for free — a subtree moves as a unit because only the subtree ROOT's file names a parent
 *   outside it. Replaces ALL of `nodeId`'s current parents, so moving a merge node deliberately
 *   dissolves its other links.
 * - `move-single`: `nodeId` alone is re-parented to `[targetId]`; its children are first spliced
 *   onto `nodeId`'s own parents so the chain it leaves behind stays connected (a child of a root
 *   correctly becomes a new base). The splice is what makes moving a node onto its own descendant
 *   a legal reorder rather than a cycle.
 * - `insert-between`: `nodeId` is spliced INTO the existing `edgeFrom -> edgeTo` link — `nodeId`
 *   revises `edgeFrom`, and `edgeTo` swaps `edgeFrom` for the inserted piece. `mode: "chain"`
 *   inserts `nodeId`'s whole subtree (so `edgeTo` ends up revising the subtree's single head, and
 *   a forked subtree is rejected as ambiguous); `mode: "single"` inserts `nodeId` by itself, with
 *   the same child-splice as `move-single`.
 * - `remove-edge`: `childId` stops revising `parentId`, keeping its other parents. `parentId` may
 *   be a missing (ghost) id — that is how a broken link is deleted rather than repaired.
 */
export type TopologyOp =
  | { kind: "move-chain"; nodeId: string; targetId: string }
  | { kind: "move-single"; nodeId: string; targetId: string }
  | { kind: "insert-between"; nodeId: string; edgeFrom: string; edgeTo: string; mode: "chain" | "single" }
  | { kind: "remove-edge"; parentId: string; childId: string };

/**
 * One file's complete new parent list — `newDownRevisions` is the WHOLE `down_revision` value the
 * file should end up with (`[]` = `None`, one id = scalar, more = tuple), already deduplicated and
 * ordered, ready to hand to `computeDownRevisionsRewrite` (core/downRevisionEdit.ts).
 */
export interface TopologyFileEdit {
  revisionId: string;
  filePath: string;
  newDownRevisions: string[];
}

/**
 * Result of planning a `TopologyOp`. `ok: false` carries a user-facing `reason` (guard rejections:
 * unknown ids, cycles, no-ops); `ok: true` carries every file rewrite the op implies — at most one
 * per revision, composed when a revision is touched by two steps of the same op — plus `summary`
 * (one line describing the op, for a confirm prompt) and `appliedTouched` (already-applied
 * revisions on either side of an edit, so the prompt can warn about rewriting migration history
 * the DB has already run).
 */
export type TopologyPlan =
  | { ok: true; fileEdits: TopologyFileEdit[]; appliedTouched: string[]; summary: string }
  | { ok: false; reason: string };

export interface UiPrefs {
  order: "newest-top" | "newest-bottom";
  density: "comfortable" | "compact";
  expandCollapsed: boolean;
  /**
   * Task H: graph time-axis. `"horizontal"` (the default) runs the chain left→right — root on the
   * left, heads on the right — with lanes stacked vertically; `"vertical"` is the original
   * top-to-bottom layout with lanes side by side. `order`'s existing values are reinterpreted, not
   * replaced, under horizontal: `newest-bottom` (default) puts the newest revision on the RIGHT,
   * `newest-top` puts it on the LEFT — see metrics.ts's `nodeXY` for the exact mapping.
   */
  axis: "vertical" | "horizontal";
  /**
   * Edit-mode lock for the graph webview. `true` (the default — the graph always OPENS locked)
   * makes every mutating canvas GESTURE inert: card drags (chain move and ⌥/Alt splice alike),
   * ghost repoint drags, edge drops, and the edge context menu's "Remove link". Clicks, selection,
   * zoom, pan, keyboard nav, every labeled button ("Merge all N heads", ghost Restore/Import,
   * "+ New revision"), the card context menu, and every palette command stay live — a labeled
   * button cannot fire by accident, so this is an accident guard against a 4px drag rewriting
   * migration files, not a permissions system. Persisted per-workspace exactly like the prefs
   * above (workspaceState + the webview's own `setState` snapshot, converged by `applyUiPrefs`).
   */
  editLocked: boolean;
}

export interface AppState {
  project: { label: string; iniPath: string } | null;  // null = no alembic.ini found
  layout: GraphLayout;
  heads: { id: string; message: string }[];
  currentIds: string[];
  problems: Problem[];
  dbReachable: boolean;
  /** Hex color per lane index. */
  laneColors: string[];
  counts: { revisions: number; heads: number; problems: number };
  config: { showSqlPreview: boolean };
  ui: UiPrefs;
  /**
   * Task B1: git blame for missing (`ghost`) down_revision ids, keyed by the missing id — `{}`
   * until the async enrichment lands (see MigrationService's `fetchGhostBlame`), an absent key
   * means "search pending", and `null` means "searched, nothing found". JSON-serializable and
   * repo-relative-paths-only (no repo root — see gitDeletion.ts's own doc comment for why the
   * repo root itself never crosses postMessage).
   */
  ghostBlame: Record<string, GhostBlame | null>;
}

/**
 * Blame for one missing revision id (Task B1's `src/services/gitDeletion.ts`). `deleted-here`: a
 * commit on THIS branch deleted the file that used to define the id — restore-able via `git
 * restore --source=<commit>^`. `never-existed`: no such deletion was ever found (the classic
 * cherry-pick/partial-sync case — a commit was cherry-picked here whose parent was never synced);
 * `foundOn`, when present, points at a commit on some OTHER ref that still defines the id —
 * import-able via `git restore --source=<foundOn.commit>`.
 */
export type GhostBlame =
  | { kind: "deleted-here"; commit: string; shortCommit: string; author: string; date: string; subject: string; deletedFilePath: string }
  | {
      kind: "never-existed";
      introducedCommit: string;
      introducedShortCommit: string;
      introducedAuthor: string;
      introducedDate: string;
      introducedSubject: string;
      /** sha parsed from a `(cherry picked from commit ...)` trailer in the introducing commit's
       * body, per the `-x` convention; null when the trailer is absent. */
      cherryPickedFrom: string | null;
      foundOn: { ref: string; commit: string; filePath: string } | null;
    };

export interface RevisionDetail {
  id: string; hash: string; message: string;
  author: string | null; date: string | null;
  applied: boolean | null; isCurrent: boolean;
  isHead: boolean; isMerge: boolean; isBroken: boolean;
  branchLabel: string | null;
  downRevisions: { id: string; missing: boolean }[];
  filePath: string;
  upgradeBody: string | null;   // null when showSqlPreview off
  downgradeBody: string | null;
}

// ---------- webview -> host ----------
export type WebviewToHostMessage =
  | { type: "ready"; restored: Partial<UiPrefs> | null }
  | { type: "select"; id: string | null }
  // N-way task: `ids` is every revision the merge should include — length 2 for the original
  // drag-one-head-onto-another gesture (`[dragged, target]`, dnd.ts), length >= 3 for the banner's
  // "Merge all N heads" button (every current head, order per `state.heads`) or the QuickPick
  // command's multi-select. The host (mergeHeadsAction, src/ui/actions.ts) runs a single
  // `alembic merge -m <msg> <...ids>` regardless of length — alembic itself accepts any number of
  // revisions and produces one merge revision with a tuple `down_revision`.
  // `busyToken` (both messages): a webview-generated token for this request. The host action uses
  // it as the invocation's busy token, so every `busy` message that invocation broadcasts echoes
  // it back — which is what lets the graph webview's drop guard disarm ONLY on its own drop's
  // terminal busy:false (matched by token), never on a same-named operation from another
  // invocation or a stale pipeline. Optional: host-side callers (command palette) invoke the
  // actions directly without one and get a host-generated token instead.
  | { type: "merge"; ids: string[]; busyToken?: string }
  | { type: "repoint"; ghostId: string; targetId: string; busyToken?: string }
  // Freeform topology editing: any of the four `TopologyOp` gestures (see that type above) the
  // graph webview can express — drag a node/chain onto another, drop one onto an edge, cut a link.
  // The host (topologyEditAction, src/ui/actions.ts) plans it with `getTopologyPlan`, confirms only
  // when the plan touches already-applied revisions, and rewrites the `down_revision` of every file
  // the plan names. `busyToken` carries the exact same drop-guard echo semantics documented on
  // `merge` above (the busy op name is `"topology"`), and is optional for the same reason.
  | { type: "topologyEdit"; op: TopologyOp; busyToken?: string }
  | { type: "upgrade" }
  | { type: "upgradeTo"; id: string }
  | { type: "downgradeTo"; id: string }
  | { type: "previewSql"; id: string | null }   // null = head(s)
  | { type: "newRevision" }
  | { type: "copyId"; id: string }
  | { type: "exportSvg"; svg: string }
  | { type: "refresh" }
  | { type: "setOrientation"; order: UiPrefs["order"] }
  | { type: "setDensity"; density: UiPrefs["density"] }
  | { type: "setAxis"; axis: UiPrefs["axis"] }
  // Edit-mode lock task: the toolbar's Locked | Edit toggle. Posted with no optimistic webview-side
  // update — the host flips the pref and re-emits state, exactly like setAxis/setDensity above, so
  // there is only ever one authority for what the lock currently is.
  | { type: "setEditLocked"; editLocked: boolean }
  | { type: "expandCollapse" }
  | { type: "openFile"; id: string }
  | { type: "openGraph" }   // sidebar only
  // Task B2: ghost card's inline Restore/Import button — one message for both `GhostBlame` kinds
  // (the host picks the source commit/path from `state.ghostBlame[ghostId].kind`; see
  // restoreDeletedAction in src/ui/actions.ts). `ghostId` is the missing revision id (the ghost
  // node's own `id`, and the key `ghostBlame` is indexed by).
  | { type: "restoreFile"; ghostId: string };

// ---------- host -> webview ----------
export type HostToWebviewMessage =
  | { type: "state"; state: AppState }
  | { type: "detail"; forId: string | null; detail: RevisionDetail | null }
  | { type: "selectNode"; id: string }
  | { type: "toast"; level: "info" | "success" | "error"; text: string }
  | {
      type: "busy";
      // Task B2: "restore" covers BOTH the Restore (deleted-here) and Import (never-existed +
      // foundOn) ghost-card button flows — they're the same host action (restoreDeletedAction),
      // distinguished only by the `GhostBlame` kind it reads, so one busy op name covers both.
      // "topology" covers all four freeform `TopologyOp` kinds (move/insert/remove-edge): they're
      // one host action (topologyEditAction) over one apply layer, so one busy op name covers them
      // the same way "restore" covers both ghost-card flows.
      operation: "merge" | "repoint" | "upgrade" | "downgrade" | "scan" | "revision" | "sql" | "restore" | "topology";
      // Unique per action INVOCATION (src/ui/actions.ts's newBusyToken) — webviews key their
      // busyOps sets on this, not on `operation`, so the stale terminal busy:false that
      // shouldDeliverStale (core/broadcastGate.ts) deliberately lets through from a superseded
      // pipeline can only ever clear its own invocation's entry, never a same-named operation the
      // CURRENT pipeline still has in flight. `operation` remains for operation-scoped consumers
      // (the graph webview's drop guard disarms on merge/repoint/topology terminal messages by
      // name — every operation a drag drop can post, each of which can abort before any busy:true).
      token: string;
      active: boolean;
    }
  // sidebar only: told explicitly (rather than inferred from silence) that the host found no
  // alembic.ini anywhere in the workspace — see src/ui/sidebarView.ts and
  // src/webview/sidebar/main.ts for why this exists as its own message instead of just never
  // sending "state".
  | { type: "noProject" }
  // sidebar only: sent by SidebarViewProvider.rebind when a project switch lands on a service
  // whose first scan hasn't completed yet. The sidebar webview survives the switch with the OLD
  // project's state still rendered (and cached as its `lastState`) — this message drops that
  // cache and shows the neutral "Scanning migrations…" placeholder, so a slow or failing first
  // scan can never leave the previous project's data on screen with commands targeting the new
  // one.
  | { type: "scanning" }
  // Belt-and-braces reset sent on every project switch (SidebarViewProvider.rebind, extension.ts):
  // unconditionally wipe whichever busy operations this webview thinks are in flight and re-render,
  // regardless of whether every matching "busy" active:false ever arrived. Closes the same gap as
  // core/broadcastGate.ts's shouldDeliverStale from a second, independent angle — see that file's
  // doc comment for the race this guards against. Handled identically by both webviews (sidebar's
  // busyOps is the persistent one that actually needs it; the graph webview's is included purely
  // for symmetry/defense-in-depth, since its panel is disposed/recreated on every switch anyway).
  | { type: "busyReset" };
