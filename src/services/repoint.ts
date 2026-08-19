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
 *      scan) and computes its new source. A read error, a transform rejection, or a file that no
 *      longer matches what the plan was built from aborts there, with NO file touched — this is
 *      where the realistic failures live (a deleted file, a hand edit, a stale scan, ...).
 *
 *      That last case is the one the plans themselves cannot see, because both are computed from
 *      the last SAVED scan while this layer writes the LIVE buffer. Each entry point guards it
 *      differently: `applyRepoint` implicitly, since `computeRepointedSource` fails outright when
 *      the file no longer references `missingId`; `applyDownRevisionEdits` explicitly, by comparing
 *      the buffer's current header against the plan's `expectedDownRevisions` — a whole-value
 *      rewrite would otherwise happily replace whatever it found, silently discarding an unsaved
 *      hand-edit and applying a composition computed against parents the file no longer has.
 *      Both guards are per-WRITTEN-file, so neither covers a post-scan change to a file the plan
 *      only READ (an untouched revision whose links shaped the plan but which earns no edit) — see
 *      `TopologyFileEdit.expectedDownRevisions` for why closing that is a different design.
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
import { computeDownRevisionsRewrite, readRevisionHeader } from "../core/downRevisionEdit";
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
 * treats them as opaque and only cares whether each file still parses into a rewritable assignment
 * AND still says what the plan expected.
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

      // The staleness guard (see the module comment). Rejecting the WHOLE batch — not just this
      // file — is the point: a topology op's edits are one atomic reshaping, and applying the
      // subset that still matches would leave the graph in a shape nobody planned or consented to.
      const header = readRevisionHeader(src);
      const matches =
        header !== null &&
        header.revisionId === edit.revisionId &&
        sameIds(header.downRevisions, edit.expectedDownRevisions);
      if (!matches) {
        return { ok: false, reason: `${edit.revisionId.slice(0, 8)}: file changed since the last scan — try again` };
      }

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

/** Order-SENSITIVE parent-list comparison for the staleness guard: a `down_revision` tuple's order
 * is part of its meaning (alembic reports the first parent as the primary one, and the graph draws
 * it that way), so a reordered list is a changed file, not an equivalent one. Same element-wise
 * comparison `MigrationService`'s own `sameList` makes when it decides an edit is a no-op — kept
 * local rather than shared because this module must not import the service that produced the
 * plan. */
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
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
