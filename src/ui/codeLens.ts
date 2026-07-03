/**
 * "◈ Show in Migration Graph" CodeLens on `versions/*.py` revision files — one lens above the
 * `revision = ...` assignment that opens/reveals the graph panel with that node selected and
 * centered (GraphPanelManager.revealAndSelect, already built for Task 12's sidebar hand-off).
 * Scoped to the project's versions dir via a DocumentSelector, NOT every Python file in the
 * workspace, so this extension never paints a lens over unrelated Python source. Line-finding is
 * parser-backed (core/parser.ts, already unit-tested) — this provider stays thin glue.
 */
import * as vscode from "vscode";
import { parseRevisionSource } from "../core/parser";
import type { MigrationService } from "../services/migrationService";
import type { GraphPanelManager } from "./graphPanel";

export function createCodeLensProvider(service: MigrationService, panelManager: GraphPanelManager): vscode.Disposable {
  const emitter = new vscode.EventEmitter<void>();

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: emitter.event,
    provideCodeLenses(document): vscode.CodeLens[] {
      const state = service.getState();
      if (state === null) return [];

      // A collapsed revision has no individual layout node (it's folded into a "collapse"
      // placeholder), so opening its file simply gets no lens until it's expanded again — same
      // "no state / file not in graph -> no lenses" rule as an unknown file.
      const node = state.layout.nodes.find((n) => n.filePath === document.uri.fsPath);
      if (node === undefined) return [];

      const parsed = parseRevisionSource(document.getText(), document.uri.fsPath);
      if (parsed === null) return [];

      const range = new vscode.Range(parsed.revisionLine, 0, parsed.revisionLine, 0);
      return [
        new vscode.CodeLens(range, {
          title: "◈ Show in Migration Graph",
          command: "alembicGraph.showInGraph",
          arguments: [node.id],
        }),
      ];
    },
  };

  const versionsDir = service.getVersionsDir();
  const selector: vscode.DocumentSelector = { pattern: new vscode.RelativePattern(versionsDir, "*.py") };
  const registration = vscode.languages.registerCodeLensProvider(selector, provider);

  // The lens set can change when files change (a broken link gets repointed, a revision moves
  // in/out of a collapsed run, etc.) — re-derived from the same state every other UI surface reacts
  // to, not a separate file watcher.
  const subscription = service.onDidChangeState(() => emitter.fire());

  return {
    dispose() {
      registration.dispose();
      subscription.dispose();
      emitter.dispose();
    },
  };
}
