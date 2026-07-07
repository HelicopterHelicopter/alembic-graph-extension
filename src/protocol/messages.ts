import type { GraphLayout, Problem } from "../core/types";

// ---------- shared payloads ----------
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
  | { type: "merge"; a: string; b: string }
  | { type: "repoint"; ghostId: string; targetId: string }
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
      operation: "merge" | "repoint" | "upgrade" | "downgrade" | "scan" | "revision" | "sql" | "restore";
      active: boolean;
    }
  // sidebar only: told explicitly (rather than inferred from silence) that the host found no
  // alembic.ini anywhere in the workspace — see src/ui/sidebarView.ts and
  // src/webview/sidebar/main.ts for why this exists as its own message instead of just never
  // sending "state".
  | { type: "noProject" }
  // Belt-and-braces reset sent on every project switch (SidebarViewProvider.rebind, extension.ts):
  // unconditionally wipe whichever busy operations this webview thinks are in flight and re-render,
  // regardless of whether every matching "busy" active:false ever arrived. Closes the same gap as
  // core/broadcastGate.ts's shouldDeliverStale from a second, independent angle — see that file's
  // doc comment for the race this guards against. Handled identically by both webviews (sidebar's
  // busyOps is the persistent one that actually needs it; the graph webview's is included purely
  // for symmetry/defense-in-depth, since its panel is disposed/recreated on every switch anyway).
  | { type: "busyReset" };
