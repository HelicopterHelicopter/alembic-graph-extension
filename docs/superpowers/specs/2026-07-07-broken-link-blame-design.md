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
4. Not a git repo / git missing / nothing found → `null`. Never throws. Per-missing-id cache, cleared on project switch (mirror `gitAuthor.ts`'s shape, injected `exec` for tests).

`GhostBlame = { commit: string; shortCommit: string; author: string; date: string; subject: string; deletedFilePath: string }` (repo-relative path; store the repo root alongside for the restore action).

## Data flow

- `AppState` gains `ghostBlame: Record<string, GhostBlame | null>` — key = ghost (missing revision) id; `null` = searched-and-not-found; key absent = search pending. JSON-serializable; rides the existing `state` message.
- `MigrationService`: optional dep `fetchGhostBlame?: (missingIds: string[]) => Promise<Record<string, GhostBlame | null>>`. After the static emit, when `graph.ghosts` is non-empty, fire it alongside the current/author enrichments; on resolve, generation-guard, merge into state, single re-emit. Enrichments compose (each re-emit includes previously landed enrichment data — same pattern as authors).
- Diagnostics: `buildFileDiagnostics` already rebuilds from state on every emit; extend the broken-link message with `— deleted in <shortCommit> by <author>` when blame for that missing id is present. No new publish machinery.

## UI

- **Ghost card** (`render.ts`): when blame is present, ONE compact line rendered below the card exactly like the broken-hint (absolute, top 100%+4px — keeps GHOST_H at 54, no metrics/layout changes, and fits the inter-lane gap in horizontal compact mode): `deleted in <shortCommit> · <author> · <date.slice(0,10)>` followed inline by a small `Restore` button (busy-disabled like all affordances). The commit subject goes in the line's `title` attribute (hover tooltip), not a second line. While the search is pending or when blame is null: nothing renders (card unchanged). The block is pointer-events none except the button.
- **Restore button** → `post({type:"restoreFile", ghostId})`. New `WebviewToHostMessage` variant; busy op union gains `"restore"`.

## Restore action (`restoreDeletedAction` in `src/ui/actions.ts`)

Standard never-throw / busy-in-finally shape:
1. Look up blame from current state (missing → error toast).
2. Guard: `<repoRoot>/<deletedFilePath>` already exists → error toast ("file already exists — rescan pending?").
3. Modal: `Restore <basename> deleted in <shortCommit>? This re-adds the file to your working tree.` → confirm "Restore".
4. `busy(restore,true)` → `git restore --source=<commit>^ -- <deletedFilePath>` (execFile, cwd = repo root — resolve via `git rev-parse --show-toplevel` at search time and carry it in the service, NOT in the postMessage payload).
5. Success toast `Restored <basename> · broken link healed`; the versions watcher rescans automatically (the ghost, BROKEN badge, and diagnostic disappear). Failure → stderr toast + `showErrorMessage`.

Chained deletions (the restored file's own parent also deleted) simply produce the next ghost on rescan — no special handling.

## Testing

- **Unit (vitest, injected exec):** pickaxe parse (NUL-separated format + name-status), verification accept/reject (defining file vs. referencing file), fallback path, not-a-repo → null, cache behavior, generation-guard discard (mirror the author-enrichment tests).
- **Integration (real git, tmp dir):** `git init` a scratch repo; commit the healthy fixture's versions files; delete one file in commit 2; run the real `findDeletionCommit` → asserts commit 2's sha/author/subject and the path; run the real restore command → file back on disk, `parseRevisionSource` parses it, and (with the repo venv) `alembic heads` succeeds. Cleanup in afterAll. skipIf git missing.
- **Playwright (harness):** seed `ghostBlame` in state → ghost card shows the blame block; Restore click posts `restoreFile`; busy disables the button; absent blame → card unchanged.

## Out of scope

Blame for *modified* (not deleted) revision ids; multi-repo workspaces beyond the current single-project model; restoring across renames (`--follow`); sidebar changes.
