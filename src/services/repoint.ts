/**
 * Applies a `getRepointPlan` (src/services/migrationService.ts) to disk: rewrites each broken
 * child's `down_revision` from `missingId` to `targetId` via `core/repoint.ts`'s pure text
 * surgery, one `vscode.WorkspaceEdit` per file. This is the only file besides discovery.ts and
 * extension.ts allowed to import `vscode` for this feature — `core/repoint.ts` (the actual text
 * transform) and `MigrationService.getRepointPlan` (the guarded plan) both stay pure/host-agnostic.
 */
import * as vscode from "vscode";
import { computeRepointedSource } from "../core/repoint";

export interface RepointEdit {
  revisionId: string;
  filePath: string;
}

/**
 * Per edit, in order: opens the document fresh (NOT `MigrationService`'s cached raw content — the
 * file could have changed on disk since the last scan), computes the repointed source, replaces
 * the full document range, applies the edit, and saves. The first failure (a read error, a
 * `computeRepointedSource` rejection, `applyEdit` returning false, or a save failure) aborts the
 * whole batch immediately with its reason — edits already applied to earlier files in the batch
 * are left as-is; the file-watcher-triggered rescan will surface whatever the real on-disk state
 * ends up being, same as any other partially-applied multi-file operation in this extension.
 */
export async function applyRepoint(
  edits: RepointEdit[],
  missingId: string,
  targetId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const edit of edits) {
    try {
      const uri = vscode.Uri.file(edit.filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const src = document.getText();

      const result = computeRepointedSource(src, missingId, targetId);
      if (!result.ok) {
        return { ok: false, reason: `${edit.revisionId.slice(0, 8)}: ${result.reason}` };
      }

      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(src.length));
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.replace(uri, fullRange, result.newSrc);

      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) {
        return { ok: false, reason: `${edit.revisionId.slice(0, 8)}: failed to apply the text edit` };
      }

      await document.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `${edit.revisionId.slice(0, 8)}: ${message}` };
    }
  }
  return { ok: true };
}
