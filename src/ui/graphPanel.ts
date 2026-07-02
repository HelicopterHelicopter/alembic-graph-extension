/**
 * Owns the singleton "Migration Graph" webview panel: creation/reveal, the serializer that
 * restores it across window reloads, and typed message dispatch. Task 9 (rendering), 10
 * (details), 11 (persistence) all build on `attach()`/`handleMessage()` — keep them the single
 * seam other tasks extend.
 */
import * as vscode from "vscode";
import { buildWebviewHtml } from "./html";
import type { MigrationService } from "../services/migrationService";
import type { WebviewToHostMessage } from "../protocol/messages";

const VIEW_TYPE = "alembicGraph.graphPanel";
const TITLE = "Migration Graph";

export class GraphPanelManager {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: MigrationService,
    private readonly log: (line: string) => void,
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

    const messageSub = panel.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      this.handleMessage(panel, msg);
    });

    const stateSub = this.service.onDidChangeState((state) => {
      void panel.webview.postMessage({ type: "state", state });
    });

    panel.onDidDispose(() => {
      messageSub.dispose();
      stateSub.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
  }

  private handleMessage(panel: vscode.WebviewPanel, msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case "ready": {
        // `msg.restored` (persisted UI prefs) is wired up in Task 11.
        const state = this.service.getState();
        if (state) void panel.webview.postMessage({ type: "state", state });
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
        void panel.webview.postMessage({ type: "detail", detail });
        break;
      }
      default:
        this.log(`graph panel: message not implemented yet: ${msg.type}`);
    }
  }
}
