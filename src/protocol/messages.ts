import type { GraphLayout, Problem } from "../core/types";

// ---------- shared payloads ----------
export interface UiPrefs {
  order: "newest-top" | "newest-bottom";
  density: "comfortable" | "compact";
  expandCollapsed: boolean;
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
}

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
  | { type: "expandCollapse" }
  | { type: "openFile"; id: string }
  | { type: "openGraph" };   // sidebar only

// ---------- host -> webview ----------
export type HostToWebviewMessage =
  | { type: "state"; state: AppState }
  | { type: "detail"; forId: string | null; detail: RevisionDetail | null }
  | { type: "selectNode"; id: string }
  | { type: "toast"; level: "info" | "success" | "error"; text: string }
  | {
      type: "busy";
      operation: "merge" | "repoint" | "upgrade" | "downgrade" | "scan" | "revision" | "sql";
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
