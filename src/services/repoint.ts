/**
 * Applies a `getRepointPlan` (src/services/migrationService.ts) to disk: rewrites each broken
 * child's `down_revision` from `missingId` to `targetId` via `core/repoint.ts`'s pure text
 * surgery, all files validated up front and applied in one combined `vscode.WorkspaceEdit`. This is the only file besides discovery.ts and
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
 * Three phases, so a failure can't report `ok:false` with half the batch already modified:
 *
 *   1. READ + VALIDATE every file first — opens each document fresh (NOT `MigrationService`'s
 *      cached raw content: the file could have changed on disk since the last scan) and computes
 *      its repointed source. A read error or `computeRepointedSource` rejection aborts here, with
 *      NO file touched — this is where the realistic failures live (a hand-edited file that no
 *      longer contains the expected down_revision, a deleted file, ...).
 *   2. APPLY one combined `WorkspaceEdit` covering every file. VS Code applies it as a single
 *      operation (`applyEdit` returning false rejects the lot).
 *   3. SAVE each document, checking the result. A save failure here CAN still leave earlier files
 *      saved and later ones dirty-but-edited (VS Code offers no cross-file save transaction, and
 *      deliberately no rollback machinery here) — but by then every buffer already holds the
 *      validated edit, the failure reason says which file stalled, and the file-watcher-triggered
 *      rescan surfaces whatever the real on-disk state ends up being.
 */
export async function applyRepoint(
  edits: RepointEdit[],
  missingId: string,
  targetId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const prepared: { revisionId: string; uri: vscode.Uri; document: vscode.TextDocument; src: string; newSrc: string }[] = [];

  for (const edit of edits) {
    try {
      const uri = vscode.Uri.file(edit.filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const src = document.getText();

      const result = computeRepointedSource(src, missingId, targetId);
      if (!result.ok) {
        return { ok: false, reason: `${edit.revisionId.slice(0, 8)}: ${result.reason}` };
      }
      prepared.push({ revisionId: edit.revisionId, uri, document, src, newSrc: result.newSrc });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `${edit.revisionId.slice(0, 8)}: ${message}` };
    }
  }

  try {
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const p of prepared) {
      // Re-check each buffer against the text the edit was computed from: phase 1's later
      // openTextDocument awaits leave a window where an earlier file's buffer can change (a user
      // keystroke, format-on-type, another extension). WorkspaceEdit.replace carries no version
      // guard of its own, so a stale range would silently leave duplicated tail text (buffer
      // grew) or discard the interleaved edit (buffer shrank). No await sits between these checks
      // and applyEdit below, so a passing check is still valid when the edit applies.
      if (p.document.getText() !== p.src) {
        return { ok: false, reason: `${p.revisionId.slice(0, 8)}: file changed while preparing the edit — retry` };
      }
      const fullRange = new vscode.Range(p.document.positionAt(0), p.document.positionAt(p.src.length));
      workspaceEdit.replace(p.uri, fullRange, p.newSrc);
    }
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      return { ok: false, reason: "failed to apply the combined text edit" };
    }

    for (const p of prepared) {
      const saved = await p.document.save();
      // save() resolves false BOTH on failure and when the document wasn't dirty (vscode.d.ts) —
      // e.g. files.autoSave flushed the buffer between applyEdit and this loop. Only a document
      // that is STILL dirty after a false save() actually failed to reach disk.
      if (!saved && p.document.isDirty) {
        return { ok: false, reason: `${p.revisionId.slice(0, 8)}: failed to save` };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
  return { ok: true };
}
