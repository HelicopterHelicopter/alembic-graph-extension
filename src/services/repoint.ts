/**
 * Host-side apply layer for planned `down_revision` rewrites — two entry points over one shared
 * write path:
 *
 *   - `applyRepoint` applies a `getRepointPlan` (src/services/migrationService.ts): each broken
 *     child's `down_revision` swaps `missingId` for `targetId`, arity untouched, via
 *     `core/repoint.ts`'s pure text surgery.
 *   - `applyDownRevisionEdits` applies a `getTopologyPlan`'s `fileEdits`: each file's WHOLE parent
 *     list is rewritten to the planned one (arity free — `None` ↔ scalar ↔ tuple), via
 *     `core/downRevisionEdit.ts`'s pure text surgery.
 *
 * Both follow the same three phases, so a failure can't report `ok:false` with half the batch
 * already modified:
 *
 *   1. READ + VALIDATE every file first — each entry point's own loop below, differing only in
 *      which pure transform computes the new source. Opens each document fresh (NOT
 *      `MigrationService`'s cached raw content: the file could have changed on disk since the last
 *      scan) and computes its new source. A read error or a transform rejection aborts there, with
 *      NO file touched — this is where the realistic failures live (a hand-edited file that no
 *      longer contains the expected down_revision, a deleted file, ...).
 *   2. APPLY one combined `WorkspaceEdit` covering every file. VS Code applies it as a single
 *      operation (`applyEdit` returning false rejects the lot).
 *   3. SAVE each document, checking the result. A save failure here CAN still leave earlier files
 *      saved and later ones dirty-but-edited (VS Code offers no cross-file save transaction, and
 *      deliberately no rollback machinery here) — but by then every buffer already holds the
 *      validated edit, the failure reason says which file stalled, and the file-watcher-triggered
 *      rescan surfaces whatever the real on-disk state ends up being.
 *
 * Phases 2+3 are identical for both entry points, so they live once in `applyPreparedEdits`. This
 * is the only file besides discovery.ts and extension.ts allowed to import `vscode` for these
 * features — `core/repoint.ts` and `core/downRevisionEdit.ts` (the actual text transforms) and
 * `MigrationService`'s plan builders (the guarded plans) all stay pure/host-agnostic.
 */
import * as vscode from "vscode";
import { computeRepointedSource } from "../core/repoint";
import { computeDownRevisionsRewrite } from "../core/downRevisionEdit";
import type { TopologyFileEdit } from "../protocol/messages";

export interface RepointEdit {
  revisionId: string;
  filePath: string;
}

/** One phase-1-validated file rewrite. `src` is the exact buffer text `newSrc` was computed from —
 * phase 2's staleness recheck compares the live buffer against it. */
interface PreparedEdit {
  revisionId: string;
  uri: vscode.Uri;
  document: vscode.TextDocument;
  src: string;
  newSrc: string;
}

/**
 * Phase 1 of the repoint flow (see the module comment): validates every edit with
 * `computeRepointedSource`, touching nothing until all of them pass.
 */
export async function applyRepoint(
  edits: RepointEdit[],
  missingId: string,
  targetId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const prepared: PreparedEdit[] = [];

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

  return applyPreparedEdits(prepared);
}

/**
 * Phase 1 of the freeform-topology flow (see the module comment): validates every planned file
 * edit with `computeDownRevisionsRewrite`, which replaces the file's whole `down_revision` value
 * with `edit.newDownRevisions` (`[]` = `None`), touching nothing until all of them pass. The plan's
 * edits are already deduplicated, cycle-guarded and composed by `getTopologyPlan` — this layer
 * treats them as opaque and only cares whether each file still parses into a rewritable
 * assignment.
 */
export async function applyDownRevisionEdits(
  edits: TopologyFileEdit[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const prepared: PreparedEdit[] = [];

  for (const edit of edits) {
    try {
      const uri = vscode.Uri.file(edit.filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const src = document.getText();

      const result = computeDownRevisionsRewrite(src, edit.newDownRevisions);
      if (!result.ok) {
        return { ok: false, reason: `${edit.revisionId.slice(0, 8)}: ${result.reason}` };
      }
      prepared.push({ revisionId: edit.revisionId, uri, document, src, newSrc: result.newSrc });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `${edit.revisionId.slice(0, 8)}: ${message}` };
    }
  }

  return applyPreparedEdits(prepared);
}

/** Phases 2+3 (see the module comment) — the write half both entry points share, unchanged by
 * which pure transform produced each `newSrc`. */
async function applyPreparedEdits(prepared: PreparedEdit[]): Promise<{ ok: true } | { ok: false; reason: string }> {
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
