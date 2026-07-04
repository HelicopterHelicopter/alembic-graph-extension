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
  /** The state-change subscription posting into `this.view`, if any — always installed via
   * `subscribeState` (the only writer), which is what keeps this in lockstep with `this.view`
   * across both the initial `resolveWebviewView` bind and any later `rebind()` project switch. */
  private stateSub: { dispose(): void } | undefined;

  private service: MigrationService | null;
  private panelManager: GraphPanelManager | null;
  /** Shared ActionContext built by extension.ts (Task 16) — null in no-project mode, where the
   * upgrade button's post degrades to a log line. Late-bound broadcast inside, same note as
   * GraphPanelManager's constructor. */
  private actionCtx: ActionContext | null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    service: MigrationService | null,
    panelManager: GraphPanelManager | null,
    private readonly log: (line: string) => void,
    actionCtx: ActionContext | null,
  ) {
    this.service = service;
    this.panelManager = panelManager;
    this.actionCtx = actionCtx;
  }

  /** Posts `msg` to the currently resolved sidebar webview; a no-op when the view isn't resolved
   * (never opened, or currently torn down). The sidebar leg of `ActionContext.broadcast`
   * (src/ui/actions.ts) — mirrors GraphPanelManager.postMessage. */
  postMessage(msg: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  /**
   * (Re-)subscribes `view` to `service`'s state changes, disposing whatever the previous
   * subscription was first. Shared by `resolveWebviewView` (first bind) and `rebind` (a later
   * project switch) so "swap the live subscription" has exactly one implementation — the two
   * callers differ only in whether they push an immediate snapshot afterward (resolveWebviewView
   * defers that to the webview's own "ready" handshake; rebind's target view already completed
   * that handshake long ago, so it pushes right away — see rebind's doc comment).
   *
   * Deliberately keeps no local capture of the subscription: `this.stateSub` is always the ONE
   * subscription currently posting into `this.view`, kept true by every caller of this method
   * (both go through it, never assign `this.stateSub` directly), which is what lets
   * `onDidDispose` below dispose+clear it correctly with nothing fancier than `this.view ===
   * webviewView` — see that comment for the cross-instance leak this replaced.
   */
  private subscribeState(view: vscode.WebviewView, service: MigrationService | null): void {
    this.stateSub?.dispose();
    this.stateSub = service?.onDidChangeState((state) => {
      void view.webview.postMessage({ type: "state", state });
    });
  }

  /**
   * Task 21's `selectProject` in-place project switch: rebinds this SAME sidebar instance to a
   * different (or absent) project's service/panelManager/actionCtx, without re-registering the
   * webview view provider. Re-registering isn't an option — VS Code calls `resolveWebviewView`
   * once per view lifetime, and there's no supported way to hand an already-resolved view off to a
   * second provider registration — so this instance has to stay the single, stable owner of the
   * `alembicGraph.sidebar` view for the life of the extension, and just swap what it's backed by.
   *
   * If the webview happens to not be resolved yet (never opened), there's nothing to push — the
   * next `resolveWebviewView` call (or the `ready` handler within it) picks up these new refs
   * naturally. If it IS resolved, tears down the old state subscription, wires a new one, and
   * immediately re-pushes: the new service's current state if it has one yet, or `noProject` if
   * switching to a project-less state. (A brand new project's service has no state until its first
   * `refresh()` lands a moment later — that brief window is covered the same way the initial
   * "Scanning migrations…" placeholder covers it on first load: no message posted yet.)
   */
  rebind(service: MigrationService | null, panelManager: GraphPanelManager | null, actionCtx: ActionContext | null): void {
    this.service = service;
    this.panelManager = panelManager;
    this.actionCtx = actionCtx;

    const view = this.view;
    if (view === undefined) {
      this.stateSub?.dispose();
      this.stateSub = undefined;
      return; // not currently resolved — nothing to push yet; the next resolve picks up these refs
    }

    this.subscribeState(view, service);

    if (service) {
      const state = service.getState();
      if (state) void view.webview.postMessage({ type: "state", state });
    } else {
      void view.webview.postMessage({ type: "noProject" });
    }
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
    this.subscribeState(webviewView, this.service);

    // Belt-and-suspenders re-push for the case where the webview instance survives a hide (no
    // guarantee either way for WebviewView) and state changed while it was hidden.
    const visibilitySub = webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible || !this.service) return;
      const state = this.service.getState();
      if (state) void webviewView.webview.postMessage({ type: "state", state });
    });

    webviewView.onDidDispose(() => {
      messageSub.dispose();
      visibilitySub.dispose();
      // Only touch shared instance fields if WE are still the current view — a re-resolve may
      // already have replaced `this.view` with a fresh one, whose (possibly since-`rebind()`-ed)
      // subscription must keep flowing untouched. When we ARE still current, `this.stateSub` is
      // guaranteed (by `subscribeState` being the only writer) to be exactly the subscription
      // posting into US, whether it's the one installed right above or a later one a `rebind()`
      // swapped in since — either way it's ours to dispose here, and nothing else's.
      if (this.view === webviewView) {
        this.stateSub?.dispose();
        this.view = undefined;
        this.stateSub = undefined;
      }
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
