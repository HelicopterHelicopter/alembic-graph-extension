# Changelog

## Unreleased

- Added: freeform topology editing in the graph — drag any revision card onto another to re-parent
  it (the whole descendant chain moves; hold ⌥/Alt to splice out just that one revision), drop a
  card onto an edge to insert it between two revisions, or right-click an edge to remove a link
  (breaking a merge parent, or detaching the only parent so the revision becomes a new base). Edits
  that touch revisions the database has already applied ask for confirmation first, and every edit
  lands as one undo step.
- Added: edit-mode lock — the graph now **opens Locked**, with a `Locked | Edit` toolbar toggle
  gating every drag gesture (including the existing merge and ghost-repair drags) and the edge
  "Remove link" menu, so a stray drag can never rewrite a migration file. Clicks, selection,
  zoom/pan, context menus, and labeled buttons stay live; the choice persists per workspace.

- Added: linked-worktree runtime support can reuse a main-checkout virtualenv, load an explicitly
  configured environment file, expand portable worktree path tokens, and resolve settings and the
  ms-python interpreter against the selected project in multi-root workspaces.

## 0.0.2 — 2026-07-10

- Added: `down_revision` ids in the revision detail panel are now clickable — jump straight to the parent revision (selection, detail, and centering follow, matching the sidebar/CodeLens navigation). Missing parents stay non-clickable; their ghost card carries the repair actions.
- Fixed: the graph toolbar now wraps onto additional rows on narrow panels instead of clipping its rightmost controls; the search box shrinks before wrapping kicks in.

## 0.0.1 — 2026-07-10

Initial release.

- Interactive migration graph (horizontal timeline by default, vertical toggle) with lanes, merge revisions, and dashed-red ghost nodes for broken `down_revision` links
- Drag one head onto another to `alembic merge`; with 3+ heads, one-click "Merge all N heads" octopus merge
- Drag a ghost onto any revision to repair the broken link, or use git blame to find the commit that deleted the missing revision — with one-click Restore (deleted on this branch) or Import (cherry-picked from another branch)
- Revision detail panel with upgrade/downgrade bodies, per-revision context menu (upgrade/downgrade to revision, offline SQL preview, copy id), new-revision creation
- Search, zoom/fit, ancestry highlighting, keyboard navigation, SVG export
- Sidebar with heads/current/problems, status bar items, Problems-panel diagnostics, CodeLens
- History is read by statically parsing `versions/*.py` — works even when broken links crash the alembic CLI; the CLI is used only for actions, resolved via settings → ms-python interpreter → project `.venv`/`venv` → PATH
