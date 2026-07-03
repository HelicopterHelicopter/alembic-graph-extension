/**
 * Owns the singleton "Migration Graph" webview panel: creation/reveal, the serializer that
 * restores it across window reloads, and typed message dispatch. Task 9 (rendering), 10
 * (details), 11 (persistence) all build on `attach()`/`handleMessage()` — keep them the single
 * seam other tasks extend.
 */
import * as vscode from "vscode";
import { buildWebviewHtml } from "./html";
import { mergeHeadsAction, repointAction, type ActionContext, type RepointActionContext } from "./actions";
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

  /** Posts `msg` to the currently open graph panel's webview; a no-op if no panel is open. This is
   * the `ActionContext.postToPanel` implementation (src/ui/actions.ts) — host-side actions (merge,
   * later upgrade/downgrade/...) never need to know whether the panel exists. */
  postMessage(msg: HostToWebviewMessage): void {
    void this.panel?.webview.postMessage(msg);
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
        // Task 14: drag-to-merge drop. `getCli()` is extension.ts's accessor for the active
        // project's AlembicCli (Task 13) — this panel doesn't own one directly since it's
        // constructed before activate() knows whether a CLI will ever be buildable.
        const cli = getCli();
        if (!cli) {
          this.log("graph panel: merge requested but no active alembic CLI is available");
          break;
        }
        const ctx: ActionContext = {
          cli,
          service: this.service,
          log: this.log,
          postToPanel: (m) => this.postMessage(m),
        };
        // mergeHeadsAction never throws in practice (see its own doc comment) — the .catch is
        // defensive only, per the brief.
        mergeHeadsAction(ctx, msg.a, msg.b).catch((err) => {
          this.log(`graph panel: mergeHeadsAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      case "repoint": {
        // Task 15: ghost-drag repoint drop. Unlike "merge" this never needs getCli() — a repoint
        // is pure text surgery via vscode's own WorkspaceEdit, no `alembic` subprocess involved.
        const ctx: RepointActionContext = {
          service: this.service,
          log: this.log,
          postToPanel: (m) => this.postMessage(m),
        };
        // repointAction never throws in practice (see its own doc comment) — the .catch is
        // defensive only, per the brief.
        repointAction(ctx, msg.ghostId, msg.targetId).catch((err) => {
          this.log(`graph panel: repointAction threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      default:
        this.log(`graph panel: message not implemented yet: ${msg.type}`);
    }
  }
}
