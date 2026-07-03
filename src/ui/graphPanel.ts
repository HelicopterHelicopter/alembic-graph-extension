/**
 * Owns the singleton "Migration Graph" webview panel: creation/reveal, the serializer that
 * restores it across window reloads, and typed message dispatch. Task 9 (rendering), 10
 * (details), 11 (persistence) all build on `attach()`/`handleMessage()` — keep them the single
 * seam other tasks extend.
 */
import * as vscode from "vscode";
import { buildWebviewHtml } from "./html";
import {
  mergeHeadsAction,
  repointAction,
  upgradeAction,
  previewSqlAction,
  downgradeToAction,
  newRevisionAction,
  type ActionContext,
  type RepointActionContext,
} from "./actions";
import { getCli } from "../extension";
import type { MigrationService } from "../services/migrationService";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../protocol/messages";

const VIEW_TYPE = "alembicGraph.graphPanel";
const TITLE = "Migration Graph";

export class GraphPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  /** True once the current `panel`'s webview has sent its "ready" message — reset on every fresh
   * attach() since a new webview instance (new panel, or a serializer-restored one) always starts
   * unready. `revealAndSelect()` uses this to decide whether it can post "selectNode" immediately
   * or must wait for the next "ready" round trip. */
  private webviewReady = false;
  /** Node id to select once the (not-yet-ready) panel's webview sends "ready" — set by
   * `revealAndSelect()` when it can't post immediately, consumed (and cleared) by the "ready" case
   * in `handleMessage()`. Deliberately NOT reset in `attach()`: it's set right before `open()` is
   * called on the same tick, so a reset there would wipe it out before "ready" ever arrives.
   * Cleared on panel disposal instead (see `attach()`'s `onDidDispose`) — otherwise a pending
   * selection whose panel closed before "ready" ever arrived would leak into a LATER, unrelated
   * panel (e.g. opened via the plain "Open Migration Graph" command) and replay a stale/unwanted
   * selection there. */
  private pendingSelectId: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: MigrationService,
    private readonly log: (line: string) => void,
    /** ActionContext.broadcast (Task 16): posts busy/toast to this panel AND the sidebar view —
     * injected by extension.ts (which owns both managers) rather than built here, so the actions
     * this panel dispatches reach the sidebar's busy-disabled upgrade button too. Late-bound: the
     * closure extension.ts passes reads the sidebar provider at call time, so constructing this
     * manager before the sidebar exists is fine. */
    private readonly broadcast: (msg: HostToWebviewMessage) => void,
  ) {}

  /** Reveals the existing panel, or creates + attaches a fresh one. */
  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      TITLE,
      vscode.ViewColumn.One,
      this.panelOptions(),
    );
    panel.iconPath = this.iconPath();
    panel.webview.html = buildWebviewHtml(panel.webview, this.context.extensionUri, "graph", TITLE);
    this.attach(panel);
  }

  /** Opens/reveals the panel and selects `id` there (Task 12: sidebar head-row clicks route
   * through here). If the panel already exists and its webview has completed the "ready" round
   * trip, selects immediately; otherwise opens/reveals the panel and defers the selection until
   * "ready" arrives (see `pendingSelectId`). */
  revealAndSelect(id: string): void {
    if (this.panel && this.webviewReady) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.panel.webview.postMessage({ type: "selectNode", id });
      return;
    }
    this.pendingSelectId = id;
    this.open();
  }

  /** Restores a panel that was open when the window last reloaded. */
  registerSerializer(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel): Promise<void> => {
        // `webview.options` only covers WebviewOptions (scripts/resource roots) — a restored
        // panel's WebviewPanelOptions (retainContextWhenHidden) are preserved by VS Code itself.
        panel.webview.options = this.webviewOptions();
        panel.iconPath = this.iconPath();
        panel.webview.html = buildWebviewHtml(panel.webview, this.context.extensionUri, "graph", TITLE);
        this.attach(panel);
      },
    });
  }

  /** Closes the current panel (if any). Safe to call when nothing is open. */
  dispose(): void {
    this.panel?.dispose();
  }

  /** Posts `msg` to the currently open graph panel's webview; a no-op if no panel is open. One of
   * the two legs of `ActionContext.broadcast` (src/ui/actions.ts — the other is
   * SidebarViewProvider.postMessage) — host-side actions (merge, upgrade, ...) never need to know
   * whether the panel exists. */
  postMessage(msg: HostToWebviewMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  /** Builds the ActionContext for a CLI-backed action dispatched from this panel's webview, or
   * null (logged) when no CLI is available. `getCli()` is extension.ts's accessor for the active
   * project's AlembicCli (Task 13), read fresh per message — this panel doesn't own one directly
   * since it's constructed before activate() knows whether a CLI will ever be buildable. */
  private buildActionContext(what: string): ActionContext | null {
    const cli = getCli();
    if (!cli) {
      this.log(`graph panel: ${what} requested but no active alembic CLI is available`);
      return null;
    }
    return { cli, service: this.service, log: this.log, broadcast: this.broadcast };
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
  }

  private panelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { ...this.webviewOptions(), retainContextWhenHidden: true };
  }

  private iconPath(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "media", "alembic.svg");
  }

  /** Shared by open() and the serializer so both code paths behave identically. Every
   * disposable created here is scoped to this exact `panel` instance via closures, so if two
   * attaches ever race (open() + a restored tab), each panel's cleanup only ever tears down its
   * own listeners — never a sibling's. */
  private attach(panel: vscode.WebviewPanel): void {
    // Singleton invariant: at most one live graph panel. Defensive only — open() and the
    // serializer both check/set `this.panel` before this point, so this should be unreachable
    // in practice.
    if (this.panel && this.panel !== panel) {
      this.panel.dispose();
    }
    this.panel = panel;
    this.webviewReady = false;

    const messageSub = panel.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      this.handleMessage(panel, msg);
    });

    const stateSub = this.service.onDidChangeState((state) => {
      void panel.webview.postMessage({ type: "state", state });
    });

    panel.onDidDispose(() => {
      messageSub.dispose();
      stateSub.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
        // A selection queued for THIS panel instance is meaningless once it's gone — don't let it
        // replay against whatever panel opens next (see `pendingSelectId`'s doc comment).
        this.pendingSelectId = null;
      }
    });
  }

  private handleMessage(panel: vscode.WebviewPanel, msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case "ready": {
        // Task 11 convergence rule: a non-null `restored` (the webview's own vscode.setState
        // copy) wins over whatever the host has in workspaceState — applyUiPrefs persists it and
        // re-layouts if needed. Either way, always post state after: a duplicate/no-op render is
        // harmless and covers the `restored === null` (host's stored prefs stand) path uniformly.
        const postCurrentState = (): void => {
          const state = this.service.getState();
          if (state) void panel.webview.postMessage({ type: "state", state });
        };
        // Task 12: this webview instance is now ready — flush any selection a revealAndSelect()
        // queued up while the panel was still opening, then let future revealAndSelect() calls
        // post "selectNode" immediately.
        const finishReady = (): void => {
          postCurrentState();
          this.webviewReady = true;
          if (this.pendingSelectId !== null) {
            const id = this.pendingSelectId;
            this.pendingSelectId = null;
            void panel.webview.postMessage({ type: "selectNode", id });
          }
        };
        if (msg.restored !== null) {
          void this.service.applyUiPrefs(msg.restored).then(finishReady);
        } else {
          finishReady();
        }
        break;
      }
      case "refresh":
        void this.service.refresh();
        break;
      case "setOrientation":
        this.service.setOrder(msg.order);
        break;
      case "setDensity":
        this.service.setDensity(msg.density);
        break;
      case "expandCollapse": {
        const state = this.service.getState();
        if (state) void this.service.setExpandCollapsed(!state.ui.expandCollapsed);
        break;
      }
      case "openFile": {
        const node = this.service.getState()?.layout.nodes.find((n) => n.id === msg.id);
        if (node?.filePath) void vscode.window.showTextDocument(vscode.Uri.file(node.filePath));
        break;
      }
      case "select": {
        const detail = msg.id === null ? null : this.service.getDetail(msg.id);
        void panel.webview.postMessage({ type: "detail", forId: msg.id, detail });
        break;
      }
      case "merge": {
        // Task 14: drag-to-merge drop.
        const ctx = this.buildActionContext("merge");
        if (!ctx) break;
        // mergeHeadsAction never throws in practice (see its own doc comment) — the .catch is
        // defensive only, per the brief.
        mergeHeadsAction(ctx, msg.a, msg.b).catch((err) => {
          this.log(`graph panel: mergeHeadsAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      case "repoint": {
        // Task 15: ghost-drag repoint drop. Unlike the CLI-backed actions this never needs
        // getCli() — a repoint is pure text surgery via vscode's own WorkspaceEdit, no `alembic`
        // subprocess involved.
        const ctx: RepointActionContext = {
          service: this.service,
          log: this.log,
          broadcast: this.broadcast,
        };
        // repointAction never throws in practice (see its own doc comment) — the .catch is
        // defensive only, per the brief.
        repointAction(ctx, msg.ghostId, msg.targetId).catch((err) => {
          this.log(`graph panel: repointAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      case "upgrade": {
        // Task 16: toolbar/card-initiated upgrade-to-heads (plural: multi-head-safe — `head`
        // errors when more than one head exists). The modal confirm lives in upgradeAction.
        const ctx = this.buildActionContext("upgrade");
        if (!ctx) break;
        upgradeAction(ctx, "heads").catch((err) => {
          this.log(`graph panel: upgradeAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      case "previewSql": {
        // Task 16: offline SQL dry run — a null id means "preview up to head(s)", per the
        // protocol comment on the message type.
        const ctx = this.buildActionContext("previewSql");
        if (!ctx) break;
        previewSqlAction(ctx, msg.id ?? "heads").catch((err) => {
          this.log(`graph panel: previewSqlAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      case "upgradeTo": {
        // Task 17: context menu "Upgrade to this revision" — reuses upgradeAction wholesale (its
        // modal already names the target and offers Preview SQL), just with a specific id instead
        // of the toolbar's "heads".
        const ctx = this.buildActionContext("upgradeTo");
        if (!ctx) break;
        upgradeAction(ctx, msg.id).catch((err) => {
          this.log(`graph panel: upgradeAction (upgradeTo) threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      case "downgradeTo": {
        // Task 17: context menu "Downgrade to this revision".
        const ctx = this.buildActionContext("downgradeTo");
        if (!ctx) break;
        downgradeToAction(ctx, msg.id).catch((err) => {
          this.log(`graph panel: downgradeToAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      case "copyId": {
        // Task 17: context menu "Copy revision id" — no CLI/action involved, just the clipboard +
        // a confirmation toast broadcast to both webviews (same as every other toast).
        void vscode.env.clipboard.writeText(msg.id);
        this.broadcast({ type: "toast", level: "info", text: `Copied ${msg.id}` });
        break;
      }
      case "newRevision": {
        // Task 17: toolbar "+ New revision".
        const ctx = this.buildActionContext("newRevision");
        if (!ctx) break;
        newRevisionAction(ctx).catch((err) => {
          this.log(`graph panel: newRevisionAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      default:
        // Reachable only for message types this panel deliberately doesn't handle:
        // "exportSvg" (Task 20) and "openGraph" (sidebar-only — the graph webview never posts it).
        this.log(`graph panel: message not implemented yet: ${msg.type}`);
    }
  }
}
