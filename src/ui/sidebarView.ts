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
import type { GraphPanelManager } from "./graphPanel";
import type { MigrationService } from "../services/migrationService";
import type { WebviewToHostMessage } from "../protocol/messages";

const TITLE = "Alembic Migrations";

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: MigrationService | null,
    private readonly panelManager: GraphPanelManager | null,
    private readonly log: (line: string) => void,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    webviewView.webview.html = buildWebviewHtml(webviewView.webview, this.extensionUri, "sidebar", TITLE);

    const messageSub = webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      this.handleMessage(webviewView, msg);
    });

    // No-project mode (this.service === null): there's no AppState to push, ever — the webview's
    // own client-side empty state (src/webview/sidebar/main.ts + render.ts's renderEmpty())
    // covers that case without any protocol message, so this subscription is simply never made.
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
    });
  }

  private handleMessage(webviewView: vscode.WebviewView, msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case "ready": {
        const state = this.service?.getState();
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
      case "upgrade":
        // Task 16 wires real execution; the footer button renders and posts regardless.
        this.log("sidebar: not implemented yet: upgrade");
        break;
      default:
        this.log(`sidebar: message not implemented yet: ${msg.type}`);
    }
  }
}
