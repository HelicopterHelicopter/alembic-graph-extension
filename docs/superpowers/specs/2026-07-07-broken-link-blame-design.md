# Broken-link blame + restore — design

**Date:** 2026-07-07 · **Status:** awaiting user review

## Problem

When a revision's `down_revision` points at a missing revision, the graph shows a ghost node and offers drag-repoint. But the missing file almost always *existed* and was deleted by some commit — the user has no way to see who deleted it, when, or why, and repointing rewrites history when restoring the deleted file is often the truer fix.

## User decisions

- **Investigate + restore** (user-confirmed): show the deleting commit's details AND offer a one-click "Restore file" repair alongside drag-repoint.
- **Auto, async per scan** (default accepted): the search runs automatically whenever ghosts exist, as a generation-guarded enrichment like the existing DB-state and author enrichments; the graph never waits on it.

## Search algorithm (`src/services/gitDeletion.ts`)

```
findDeletionCommit(missingId, versionsDir) -> GhostBlame | null
```

1. **Pickaxe:** `git log -S<missingId> --diff-filter=D --format=%H%x00%an%x00%aI%x00%s --name-status -- <versionsDir>` (cwd = versionsDir; git resolves the repo root). Newest-first.
2. **Verify each candidate:** for each commit's deleted path, read the pre-image `git show <sha>^:<path>` and parse it with the real `parseRevisionSource`; accept only if the file *defined* `revision == missingId` (rejects commits that deleted a mere referencer).
3. **Fallback** when pickaxe yields nothing (e.g., shallow clone quirks): `git log --diff-filter=D --name-only -- '<versionsDir>/*<missingId>*'` filename-prefix heuristic, same verification.
4. **Never-existed-here fallback (cherry-pick / partial sync)** — user-raised case: a cherry-picked commit introduces a migration whose parent was never in this branch's history, so no deletion commit exists. When steps 1–3 find nothing:
   a. Blame the *introduction*: `git log --diff-filter=A --format=%H%x00%an%x00%aI%x00%s%x00%B -- <broken child's filePath>` → the commit that added the referencing file; detect `(cherry picked from commit <sha>)` in the body (`-x` convention) when present.
   b. Search other refs for the missing parent: `git log --all -S<missingId> --diff-filter=A --format=… --name-status -- <versionsDir>`, candidates verified exactly like deletions (the ADDED file's content at that commit must define `revision == missingId` via `git show <sha>:<path>` + real parser). On a hit, resolve a display ref via `git branch -a --contains <sha>` (first line, trimmed).
   c. This cross-ref walk is the one potentially slow query: acceptable because it runs only when a ghost exists, only after the deletion search misses, and is cached per missing id.
5. Not a git repo / git missing / nothing found at all → `null`. Never throws. Per-missing-id cache, cleared on project switch (mirror `gitAuthor.ts`'s shape, injected `exec` for tests).

```ts
type GhostBlame =
  | { kind: "deleted-here"; commit; shortCommit; author; date; subject; deletedFilePath }   // restore-able
  | { kind: "never-existed"; introducedCommit; introducedShortCommit; introducedAuthor; introducedDate; introducedSubject;
      cherryPickedFrom: string | null;                                   // sha parsed from "(cherry picked from commit …)" or null
      foundOn: { ref: string; commit: string; filePath: string } | null } // parent located on another ref → import-able
```
(all strings; paths repo-relative; the service carries the repo root internally for the restore/import actions — never in postMessage payloads).

## Data flow

- `AppState` gains `ghostBlame: Record<string, GhostBlame | null>` — key = ghost (missing revision) id; `null` = searched-and-not-found; key absent = search pending. JSON-serializable; rides the existing `state` message.
- `MigrationService`: optional dep `fetchGhostBlame?: (missingIds: string[]) => Promise<Record<string, GhostBlame | null>>`. After the static emit, when `graph.ghosts` is non-empty, fire it alongside the current/author enrichments; on resolve, generation-guard, merge into state, single re-emit. Enrichments compose (each re-emit includes previously landed enrichment data — same pattern as authors).
- Diagnostics: `buildFileDiagnostics` already rebuilds from state on every emit; extend the broken-link message with `— deleted in <shortCommit> by <author>` when blame for that missing id is present. No new publish machinery.

## UI

- **Ghost card** (`render.ts`): when blame is present, ONE compact line rendered below the card exactly like the broken-hint (absolute, top 100%+4px — keeps GHOST_H at 54, no metrics/layout changes, and fits the inter-lane gap in horizontal compact mode). Per kind:
  - `deleted-here`: `deleted in <shortCommit> · <author> · <date.slice(0,10)>` + inline `Restore` button. Commit subject in the `title` tooltip.
  - `never-existed` with `foundOn`: `never in this branch · introduced by <author> in <shortCommit><" (cherry-pick)" when cherryPickedFrom> · parent on <ref>` + inline `Import` button. Tooltip: introduced subject.
  - `never-existed` without `foundOn`: same diagnosis line, no button, suffix `— fetch the source branch or drag to re-point`.
  - Pending or null: nothing renders (card unchanged). The block is pointer-events none except the button.
- **Restore/Import button** → `post({type:"restoreFile", ghostId})` (one message for both kinds — the host picks the source from the blame kind). New `WebviewToHostMessage` variant; busy op union gains `"restore"`.

## Restore action (`restoreDeletedAction` in `src/ui/actions.ts`)

Standard never-throw / busy-in-finally shape; source depends on blame kind:
1. Look up blame from current state (missing, or `never-existed` without `foundOn` → error toast).
2. Determine source: `deleted-here` → `--source=<commit>^ -- <deletedFilePath>`; `never-existed`+`foundOn` → `--source=<foundOn.commit> -- <foundOn.filePath>`.
3. Guard: the target path already exists in the working tree → error toast ("file already exists — rescan pending?").
4. Modal: `deleted-here`: `Restore <basename> deleted in <shortCommit>? This re-adds the file to your working tree.` / `never-existed`: `Import <basename> from <ref>? This copies the missing revision into your working tree.` → confirm "Restore"/"Import".
5. `busy(restore,true)` → `git restore --source=… -- <path>` (execFile, cwd = repo root — resolved via `git rev-parse --show-toplevel` at search time and carried in the service, NOT in the postMessage payload).
6. Success toast `Restored <basename> · broken link healed` (or `Imported <basename> from <ref> …`); the versions watcher rescans automatically (ghost, BROKEN badge, and diagnostic disappear). Failure → stderr toast + `showErrorMessage`.

Chained deletions (the restored file's own parent also deleted) simply produce the next ghost on rescan — no special handling.

## Testing

- **Unit (vitest, injected exec):** pickaxe parse (NUL-separated format + name-status), verification accept/reject (defining file vs. referencing file), fallback path, not-a-repo → null, cache behavior, generation-guard discard (mirror the author-enrichment tests).
- **Integration (real git, tmp dir):** `git init` a scratch repo; commit the healthy fixture's versions files; delete one file in commit 2; run the real `findDeletionCommit` → asserts commit 2's sha/author/subject and the path; run the real restore command → file back on disk, `parseRevisionSource` parses it, and (with the repo venv) `alembic heads` succeeds. **Cherry-pick case:** second scratch repo with two branches — branch A adds parent+child revisions; branch B cherry-picks only the child's commit (`-x`) → on B, blame returns `never-existed` with the introducing commit, parsed `cherryPickedFrom`, and `foundOn` pointing at branch A's commit/path; real `git restore --source=<foundOn.commit>` brings the parent over and a rescan shows no ghosts. Cleanup in afterAll. skipIf git missing.
- **Playwright (harness):** seed `ghostBlame` in state → ghost card shows the blame block; Restore click posts `restoreFile`; busy disables the button; absent blame → card unchanged.

## Out of scope

Blame for *modified* (not deleted) revision ids; multi-repo workspaces beyond the current single-project model; restoring across renames (`--follow`); sidebar changes.
