# Changelog

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
