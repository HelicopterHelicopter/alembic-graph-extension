/**
 * Owns the "Alembic Migrations" activity-bar sidebar webview view (`alembicGraph.sidebar`,
 * declared in package.json's `contributes.views`): heads list, current revision, problems, and
 * the upgrade-head footer button (design/Alembic Graph.dc.html's left 250px column, minus the
 * title bar VS Code already renders from the view's `name`).
 *
 * Unlike GraphPanelManager's singleton WebviewPanel, a WebviewView has no `retainContextWhenHidden`
 * equivalent — VS Code is free to tear down and recreate the webview on collapse/expand, so
 * `resolveWebviewView()` must assume nothing survived and always re-push the host's current state
 * once the webview says "ready" (and again on `onDidChangeVisibility`, for platforms where the
 * instance *does* survive a hide but missed a state change while hidden).
 */
import * as vscode from "vscode";
import { buildWebviewHtml } from "./html";
import { upgradeAction, type ActionContext } from "./actions";
import type { GraphPanelManager } from "./graphPanel";
import type { MigrationService } from "../services/migrationService";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../protocol/messages";

const TITLE = "Alembic Migrations";

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  /** The currently resolved (live) webview view, if any — see postMessage(). A WebviewView can be
   * torn down and re-resolved by VS Code at will, so this tracks whichever instance is current. */
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: MigrationService | null,
    private readonly panelManager: GraphPanelManager | null,
    private readonly log: (line: string) => void,
    /** Shared ActionContext built by extension.ts (Task 16) — null in no-project mode, where the
     * upgrade button's post degrades to a log line. Late-bound broadcast inside, same note as
     * GraphPanelManager's constructor. */
    private readonly actionCtx: ActionContext | null,
  ) {}

  /** Posts `msg` to the currently resolved sidebar webview; a no-op when the view isn't resolved
   * (never opened, or currently torn down). The sidebar leg of `ActionContext.broadcast`
   * (src/ui/actions.ts) — mirrors GraphPanelManager.postMessage. */
  postMessage(msg: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    webviewView.webview.html = buildWebviewHtml(webviewView.webview, this.extensionUri, "sidebar", TITLE);

    const messageSub = webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      this.handleMessage(webviewView, msg);
    });

    // No-project mode (this.service === null): there's no AppState to ever push — the `ready`
    // handler below tells the webview so explicitly via "noProject" instead. When a service does
    // exist, this subscription is made immediately here (not deferred to the `ready` handler), so
    // it's already live during the pre-state window between "ready" and the first scan landing —
    // the webview's neutral "Scanning migrations…" placeholder (renderScanning()) is what covers
    // that window, replaced the moment this fires.
    const stateSub = this.service?.onDidChangeState((state) => {
      void webviewView.webview.postMessage({ type: "state", state });
    });

    // Belt-and-suspenders re-push for the case where the webview instance survives a hide (no
    // guarantee either way for WebviewView) and state changed while it was hidden.
    const visibilitySub = webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible || !this.service) return;
      const state = this.service.getState();
      if (state) void webviewView.webview.postMessage({ type: "state", state });
    });

    webviewView.onDidDispose(() => {
      messageSub.dispose();
      stateSub?.dispose();
      visibilitySub.dispose();
      // Only clear if WE are still the current instance — a re-resolve may already have replaced
      // `this.view` with a fresh one whose messages must keep flowing (same guard pattern as
      // GraphPanelManager's onDidDispose).
      if (this.view === webviewView) this.view = undefined;
    });
  }

  private handleMessage(webviewView: vscode.WebviewView, msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case "ready": {
        if (!this.service) {
          // True no-project path: no alembic.ini anywhere in the workspace. Tell the webview
          // explicitly so it can replace its neutral "Scanning migrations…" placeholder with the
          // actual diagnosis, instead of leaving the webview to infer "no project" from silence
          // (which was indistinguishable from "scan still running").
          void webviewView.webview.postMessage({ type: "noProject" });
          break;
        }
        const state = this.service.getState();
        // If the scan hasn't landed yet, post nothing — the `stateSub` subscription above is
        // already live and will deliver "state" the moment it does; the webview's own
        // "Scanning migrations…" placeholder covers the gap in the meantime.
        if (state) void webviewView.webview.postMessage({ type: "state", state });
        break;
      }
      case "openGraph":
        void vscode.commands.executeCommand("alembicGraph.openGraph");
        break;
      case "select":
        // Head-row click: reveal the graph panel and select the node there. Guard null (the
        // graph webview's own deselect id) — the sidebar never sends it, but the message type is
        // shared across both webviews.
        if (msg.id !== null) this.panelManager?.revealAndSelect(msg.id);
        break;
      case "upgrade": {
        // Task 16: footer button → modal-confirmed `alembic upgrade heads` (plural: multi-head-
        // safe). actionCtx is null only in no-project mode, where there is no CLI to run — but
        // the webview never renders the footer button then either (renderNoProject), so this
        // guard is defensive.
        if (!this.actionCtx) {
          this.log("sidebar: upgrade requested but no alembic project/CLI is available");
          break;
        }
        // upgradeAction never throws in practice (see its own doc comment) — the .catch is
        // defensive only, same pattern as the graph panel's dispatch.
        upgradeAction(this.actionCtx, "heads").catch((err) => {
          this.log(`sidebar: upgradeAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      default:
        this.log(`sidebar: message not implemented yet: ${msg.type}`);
    }
  }
}
