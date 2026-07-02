import * as vscode from "vscode";
import type { MigrationService } from "../services/migrationService";
import type { AppState } from "../protocol/messages";

/** Creates the three status bar items and keeps them in sync with service state. Returns a Disposable. */
export function createStatusBar(service: MigrationService): vscode.Disposable {
  const headsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  headsItem.command = "alembicGraph.openGraph";

  const currentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  currentItem.command = "alembicGraph.openGraph";

  const revisionsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  revisionsItem.command = "alembicGraph.openGraph";

  const subscription = service.onDidChangeState((state) => {
    updateItems(state, headsItem, currentItem, revisionsItem);
  });

  // On construction: if service.getState() is non-null, render immediately
  const initialState = service.getState();
  if (initialState !== null) {
    updateItems(initialState, headsItem, currentItem, revisionsItem);
  }

  return {
    dispose() {
      headsItem.dispose();
      currentItem.dispose();
      revisionsItem.dispose();
      subscription.dispose();
    },
  };
}

function updateItems(
  state: AppState,
  headsItem: vscode.StatusBarItem,
  currentItem: vscode.StatusBarItem,
  revisionsItem: vscode.StatusBarItem,
): void {
  // If project is null, hide all three
  if (state.project === null) {
    headsItem.hide();
    currentItem.hide();
    revisionsItem.hide();
    return;
  }

  // Heads item
  const headCount = state.counts.heads;
  headsItem.text = `$(type-hierarchy) ${headCount} head${headCount === 1 ? "" : "s"}`;
  if (headCount > 1) {
    headsItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    headsItem.tooltip = `${headCount} migration heads — open the graph to merge`;
  } else {
    headsItem.backgroundColor = undefined;
    headsItem.tooltip = "Alembic migration heads";
  }
  headsItem.show();

  // Current item
  if (state.currentIds.length === 0) {
    currentItem.hide();
  } else {
    currentItem.text = `current: ${state.currentIds[0].substring(0, 10)}`;
    currentItem.tooltip = "Current database revision";
    currentItem.show();
  }

  // Revisions item
  revisionsItem.text = `${state.counts.revisions} revisions`;
  revisionsItem.tooltip = "Alembic revisions in this project";
  revisionsItem.show();
}
