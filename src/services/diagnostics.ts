/**
 * Publishes graph `Problem`s (broken down_revisions, duplicate ids) to VS Code's native Problems
 * panel. Thin glue only — the actual per-file grouping/message logic is the pure, vitest-tested
 * `buildFileDiagnostics` (core/diagnostics.ts); this file's job is just turning that into
 * `vscode.Diagnostic`s and keeping the collection in sync with `MigrationService`'s state.
 */
import * as vscode from "vscode";
import { buildFileDiagnostics } from "../core/diagnostics";
import type { MigrationService } from "./migrationService";

/** Diagnostics are whole-line: character range is clamped by VS Code itself, so an arbitrarily
 * large end column is fine — see the brief for why `Number.MAX_SAFE_INTEGER` is avoided. */
const END_COLUMN = 1000;

/** Publishes graph problems to a DiagnosticCollection; returns a Disposable (collection + subscription). */
export function createDiagnostics(service: MigrationService): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection("alembicGraph");

  const publish = (): void => {
    // Always clear first: a shrinking problem set (e.g. a ghost just got repointed) must drop the
    // diagnostics for files that no longer have any, not just leave stale ones behind.
    collection.clear();

    const state = service.getState();
    if (state === null) return;

    const byFile = buildFileDiagnostics(state.problems);
    for (const [filePath, entries] of byFile) {
      const diagnostics = entries.map(({ line, message }) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, END_COLUMN),
          message,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "alembic-graph";
        return diagnostic;
      });
      collection.set(vscode.Uri.file(filePath), diagnostics);
    }
  };

  const subscription = service.onDidChangeState(publish);
  publish(); // immediately if state already exists (e.g. this is wired up after the first refresh)

  return {
    dispose() {
      subscription.dispose();
      collection.clear();
      collection.dispose();
    },
  };
}
