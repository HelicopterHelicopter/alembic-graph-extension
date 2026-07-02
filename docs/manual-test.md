# Alembic Graph — manual test checklist

Steps that can only be verified by actually running the extension in the VS Code Extension
Development Host (F5) — things vitest can't reach. Each task appends its own section as
functionality lands; run `npm run build` first (or let the `npm: build` preLaunchTask do it).

## Task 6: discovery + migration scan service

Launch config: **Run Extension (broken fixture)** (`.vscode/launch.json`) — opens
`fixtures/broken-project` as the workspace folder.

1. Press F5, select **Run Extension (broken fixture)**.
2. In the spawned Extension Development Host window, open **View → Output**, and pick
   **Alembic Graph** from the channel dropdown.
3. Expect to see, in order:
   - `using project: broken-project / alembic (<path>/fixtures/broken-project/alembic.ini)`
   - `scan: 12 files, 12 revisions, 3 heads, 1 problems`
   - a single-line JSON dump of the full `AppState` (starts `{"project":{"label":"broken-project / alembic"...`)
     - spot-check: `"counts":{"revisions":12,"heads":3,"problems":1}`, `"dbReachable":false`,
       `"laneColors"` has 2 entries, `"layout":{"nodes":[...]}` has 13 entries (12 revisions +
       1 ghost node for the missing `deadbeef0000` revision).
4. Run the command **Alembic Graph: Refresh** (Command Palette). Expect the same two log lines
   to be appended again (a second scan + JSON dump), with unchanged counts.
5. Touch a file to exercise the file watcher: with the Output panel still visible, edit and save
   any file under `fixtures/broken-project/alembic/versions/*.py` (e.g. add a trailing blank
   line to `8f2a1c9d4e07_create_products_table.py` and save). Within ~300ms (the debounce
   window) expect one more `scan:` + JSON pair to appear — not one per keystroke/save-spam if
   you save a few times quickly in a row (the debounce should coalesce rapid saves into a single
   rescan).
6. Run the other four commands from the Command Palette (**Alembic Graph: Open Migration
   Graph**, **Upgrade to Head**, **Merge Heads…**, **Select Alembic Project…**) and confirm each
   shows an information toast ending in "— not implemented yet" (they're stubs until later
   tasks) rather than throwing or silently doing nothing.
7. Repeat steps 1–3 with the **Run Extension (healthy fixture)** launch config: expect
   `scan: 11 files, 11 revisions, 2 heads, 0 problems` (no ghost node, no broken link) and a
   `layout.nodes` length of 11.

### Known deviation from the task brief

The brief's expected log line was `scan: 13 files, 12 revisions, 3 heads, 1 problems`. The
`fixtures/broken-project/alembic/versions/` directory actually contains exactly 12 `*.py` files
(all 12 parse successfully — confirmed by `parser.test.ts`'s "has exactly 12 revision files in
the fixture" assertion), so a real scan reports `12 files` here, not `13`. The `13` in the brief
appears to be a mix-up with the **layout node count** (12 revisions + 1 ghost = 13 `layout.nodes`
entries), which the JSON dump does correctly show. `migrationService.test.ts` test 2 separately
exercises the "extra file that fails to parse" case (feeding a 13th, env.py-like file into a
fake `listVersionFiles`) — that scenario is real and tested, it just isn't what a real F5 run
against the fixture produces.

## Task 7: status bar items

1. Press F5, select **Run Extension (broken fixture)**.
2. Look at the left side of the VS Code status bar (bottom of the editor window).
3. Expect to see three status bar items from left to right:
   - `$(type-hierarchy) 3 heads` with a warning background (orange/yellow tint), tooltip
     "3 migration heads — open the graph to merge"
   - `12 revisions`, tooltip "Alembic revisions in this project"
   - No `current:` item (since `currentIds` is empty — DB state enrichment arrives in Task 13)
4. Click any of the visible status bar items and confirm it triggers the **Alembic Graph: Open
   Migration Graph** command, showing an information toast "Alembic Graph: Open Migration Graph —
   not implemented yet" (stub until Task 8).
5. Repeat with **Run Extension (healthy fixture)** launch config: expect `$(type-hierarchy) 2 heads`
   with no warning background (singular check: text is `1 head` if only one head), and
   `11 revisions`.

## Task 8: webview panel infrastructure

1. Press F5, select **Run Extension (broken fixture)**.
2. Run the command **Alembic Graph: Open Migration Graph** (Command Palette, or click a status
   bar item from Task 7). A panel titled "Migration Graph" opens in editor column one with the
   Alembic icon on its tab.
3. Expect a toolbar with a **Refresh** button, followed by a `<pre>` block containing a
   pretty-printed JSON dump of the full `AppState` (same shape as the Output-channel dump from
   Task 6). Spot-check: `"layout":{"nodes":[...]}` has 13 entries (12 revisions + 1 ghost).
4. Click **Refresh**. The dump re-renders (content unchanged, since nothing on disk changed).
   The Output channel gets one more `scan:` + JSON pair.
5. With the panel still open, touch a file under
   `fixtures/broken-project/alembic/versions/*.py` (edit + save). Within ~300ms the JSON dump
   updates live to reflect the new state, with no action needed in the webview.
6. Run **Alembic Graph: Open Migration Graph** again (or click a status bar item) while the
   panel is already open: it reveals the existing tab instead of opening a second one.
7. Open the webview DevTools (Command Palette → **Developer: Open Webview Developer Tools**)
   and check the Console: zero Content-Security-Policy violation messages.
8. Run **Developer: Reload Window**. After reload, the "Migration Graph" tab reopens
   automatically (the `WebviewPanelSerializer`) and re-populates with the current JSON dump
   without needing to re-run the open command.
9. Close the panel (click the tab's × or Cmd+W), then run **Alembic Graph: Open Migration
   Graph** again: a fresh panel opens correctly (closing doesn't wedge the singleton).
10. Repeat steps 1–5 with the **Run Extension (healthy fixture)** launch config: expect
    `layout.nodes` length of 11, no ghost/broken entries.

## Task 9: full graph rendering (theme-aware design port)

Before F5: `node scripts/dump-state.mjs` + opening `harness/graph.html` (served over http, not
`file://` — see the file's header comment) is the fast iteration loop used to build this; the
steps below are the F5-only checks that harness can't cover (real VS Code chrome/theme, live file
watch, real host round-trip for the toolbar toggles).

1. Press F5, select **Run Extension (broken fixture)**, then **Alembic Graph: Open Migration
   Graph**.
2. Visual match against `design/Alembic Graph.dc.html` (open it side by side if useful, though its
   `support.js` preview runtime isn't checked into this repo so it won't run standalone — the
   comparison is against the literal styles/measurements in that file): dark toolbar (42px) with
   project label, `● N heads` chip in warm yellow, `N revisions`, right-aligned Order/Comfortable
   toggles; dot-grid canvas background; rounded revision cards with a 4px lane-colored left stripe,
   mono hash, bold message, dim `author · date` meta row; dashed red ghost card
   (`⚠ missing revision`); dashed red bezier edge into it plus a pulsing
   `⚠ down_revision missing — drag onto a parent to re-point` hint under the broken card; a pulsing
   green `drag one head onto the other to merge ⇄` box (3 heads on this fixture); badges HEAD
   (green, ×3), MERGE (purple, ×1), BROKEN (red, ×1) in the card header.
3. Click a revision card: it gets the blue selected ring/background (`#1c8fd6` / `#093251`); click
   a different card, selection moves; nothing else re-renders/flickers.
4. Click **Newest ↑** / **Newest ↓**: the whole card stack mirrors vertically (newest at top vs.
   bottom); click **Compact**: cards shrink (92px → 76px tall, tighter row spacing) without losing
   selection or scroll position.
5. With the panel open and scrolled away from the top-left, touch a file under
   `fixtures/broken-project/alembic/versions/*.py` (edit + save). Within ~300ms the canvas
   re-renders with the new data and the canvas scroll position is unchanged (doesn't jump back to
   the top-left).
6. Collapse/expand on the **healthy fixture** (2 heads, no broken link, same root-end linear run as
   the broken fixture minus the broken branch): open **Preferences: Open Workspace Settings**, set
   **Alembic Graph › Collapse Threshold** to `3`, run **Alembic Graph: Refresh**. A dashed
   `⋮   2 earlier revisions` collapse card replaces the two oldest root-end revisions. Click it:
   it posts `expandCollapse` and the two collapsed cards reappear in its place (collapse card
   gone). Set the threshold back to its default (or remove the override) afterward.
7. Open webview DevTools (**Developer: Open Webview Developer Tools**) and confirm the Console has
   no errors and no CSP violations.
8. Repeat steps 1–4 with the **Run Extension (healthy fixture)** launch config: 2 heads (merge
   hint still shows), no ghost card, no BROKEN badge, no broken hint.

## Task 10: revision detail panel + select/detail + openFile

`harness/graph.html` (after `npm run build` + `node scripts/dump-state.mjs`, served over http —
see the file's header comment) exercises the full click → panel round trip without VS Code: the
harness's fake `vscodeApi` now responds to a `select` postMessage by looking the id up in
`harness/details.json` (generated by the same dump-state.mjs run) and dispatching a `detail`
message back asynchronously, same shape as `GraphPanelManager`'s real "select" case. The steps
below are the F5-only checks the harness can't cover (real VS Code editor tabs, live theme).

1. Press F5, select **Run Extension (broken fixture)**, then **Alembic Graph: Open Migration
   Graph**.
2. Click the `29dae0774a6c` **merge oauth and billing** card. A 328px "REVISION DETAIL" panel
   opens on the right (canvas shrinks to make room, doesn't overlap): MERGE badge; mono hash
   `29dae0774a6c`; message; `author —`; a `date`; `status Unknown` (dim — DB enrichment arrives in
   Task 13, so `applied` is always null for now); `down_revision` showing both
   `18c9d9663f5b`/`07b8c8552e4a` stacked (blue `#9cdcfe`); `file` as a blue, underline-on-hover,
   clickable path; a `MIGRATION` code box with `def upgrade():` / `pass` / `def downgrade():` /
   `pass`.
3. Click the `5c0d13aa7d9f` **add audit log** card (BROKEN + HEAD badges). Panel updates in place:
   BROKEN badge; `down_revision` shows `deadbeef0000 (missing)` in red (`#f14c4c`); the real
   multi-line `op.create_table(...)` / `op.drop_table('audit_log')` bodies render in the code box
   (horizontal-scrolls if the line is wide — doesn't wrap or overflow the panel).
4. Click the panel's **file** path (`5c0d13aa7d9f_add_audit_log.py`): the real source file opens
   in an editor tab beside the graph panel (this is real in VS Code — the harness only logs the
   `openFile` post to the console).
5. Click the panel's **✕** (top right, hover shows a subtle background). The panel closes; the
   `5c0d13aa7d9f` card keeps its selected ring/highlight (selection isn't cleared, only the panel
   hides).
6. Click the same card again (or a different one): the panel reopens/updates without needing to
   reopen the graph.
7. Click a different, still-open card while the previous one's panel is showing: the panel
   updates to the new card's detail — no stale content or flash of the old card's data attached to
   the new selection.
8. Open webview DevTools (**Developer: Open Webview Developer Tools**) and confirm the Console has
   no errors and no CSP violations while repeating steps 2–6.
9. Open **Preferences: Open Workspace Settings**, uncheck **Alembic Graph › Show Sql Preview**,
   then click a card whose panel isn't already open (or close and reselect one that is): the
   `MIGRATION` section is absent entirely (no empty code box) — `author`/`date`/`status`/
   `down_revision`/`file` rows still show normally. Re-check the setting afterward.
10. Repeat step 2 with the **Run Extension (healthy fixture)** launch config on any card: panel
    opens the same way (no broken/merge fixture there, so just confirm the badges/kv rows/code box
    render correctly for a plain linear revision).

## Task 11: UI preference persistence + restore (order/density/expandCollapse, selection, scroll)

Two stores, two lifetimes: the webview's own `vscode.setState` (order, density,
expandCollapsed, selectedId, detailOpen, scrollTop, scrollLeft — survives tab hide and
**Developer: Reload Window** while the panel's tab still exists) and the host's `workspaceState`
(order/density/expandCollapsed only — survives the panel being fully **closed**). `harness/graph.html`
(after `npm run build`, served over http — see the file's header comment) covers the webview-side
restore logic in isolation via `window.__seedState`/`?seed=`; the steps below are the F5-only
checks that harness can't cover (a real host round trip, a real window reload, a real panel
close/reopen).

1. Press F5, select **Run Extension (broken fixture)**, then **Alembic Graph: Open Migration
   Graph**.
2. Click **Newest ↑** and **Compact**, click the `29dae0774a6c` **merge oauth and billing** card
   (detail panel opens), then scroll the canvas down/right away from the top-left corner.
3. Run **Developer: Reload Window**. After reload, the "Migration Graph" tab reopens automatically
   (the serializer) and, once it repopulates: **Newest ↑** and **Compact** are still the active
   toggles, the `29dae0774a6c` card still has its selected highlight and the REVISION DETAIL panel
   for it is showing again (a fresh `select` round trip, not a cached copy — momentarily visible as
   a re-fetch if you watch closely), and the canvas is scrolled back to the same position it was at
   before reload (not snapped back to the top-left).
4. Open webview DevTools (**Developer: Open Webview Developer Tools**) and confirm the Console has
   no errors while repeating step 3.
5. Click the detail panel's **✕**, click **Comfortable**, click **Newest ↓**, then close the panel
   (click the tab's × or Cmd+W).
6. Run **Alembic Graph: Open Migration Graph** again (fresh panel, not a reload — the panel was
   fully disposed in step 5). Expect **Comfortable** and **Newest ↓** to still be the active
   toggles (round-tripped through the host's `workspaceState`, independent of the disposed
   webview's own state) — but no card selected and no detail panel open, and the canvas scrolled to
   its default top-left position (the webview's `vscode.setState` — and with it selectedId/
   detailOpen/scroll — does not survive a full close, only hide/reload; see the brief's two-store
   split).
7. With the panel open, click the collapse toggle if a collapse card is visible (or set **Alembic
   Graph › Collapse Threshold** low enough via **Preferences: Open Workspace Settings** and
   **Alembic Graph: Refresh** to produce one — see Task 9 step 6), expand it, then repeat step 3
   (**Developer: Reload Window**): the expand/collapse state is restored along with order/density.
8. Repeat steps 1–3 with the **Run Extension (healthy fixture)** launch config: same restore
   behavior (order/density/scroll; no merge card there, so pick any card for the selection check).

## Task 12: Alembic Migrations sidebar view

`harness/sidebar.html` (after `npm run build` + `node scripts/dump-state.mjs`, served over http —
see the file's header comment) covers the sidebar webview's own rendering/click-posting logic in
isolation, including the `?nostate=1` no-project empty state. The steps below are the F5-only
checks that harness can't cover (the real activity-bar icon/view, a real WebviewView's
collapse/expand lifecycle, and the real cross-webview hand-off into the graph panel).

1. Press F5, select **Run Extension (broken fixture)**.
2. Click the Alembic icon in the activity bar (left-most icon column). The "Alembic Migrations"
   sidebar view opens, showing (visual match against `design/Alembic Graph.dc.html`'s left 250px
   column, minus its own title bar — VS Code renders "ALEMBIC MIGRATIONS" as the view's native
   title instead):
   - **▾ HEADS** with a yellow `3` count pill, then three rows: `5c0d13aa7d` "add audit log",
     `4bfc02996c` "search index (experimental)", `3aebf1885b` "add rate limiting" (green ◆, mono
     hash, dim message).
   - **CURRENT REVISION**: hollow dot + dim `unknown` (DB state enrichment arrives in Task 13).
   - **PROBLEMS**: one red `⚠` row reading `` `5c0d13aa7d9f` revises missing revision
     `deadbeef0000` `` (the broken-project fixture's single problem).
   - A sticky footer button `↻ alembic upgrade head` (blue, full width).
3. Hover a head row: it highlights with the list hover background. Click the **view/title** bar's
   icons (top-right of the sidebar view): the graph icon runs **Alembic Graph: Open Migration
   Graph** and the refresh icon runs **Alembic Graph: Refresh** (both already wired from earlier
   tasks; this task doesn't change them).
4. Click the `5c0d13aa7d` **add audit log** head row. The "Migration Graph" panel opens (or, if
   already open, is revealed/focused) in editor column one, with the `5c0d13aa7d9f` card selected
   (blue ring/background) and its REVISION DETAIL panel open on the right — and the canvas is
   scrolled so the card is roughly centered in the viewport (not just barely in view at an edge).
5. With the graph panel still open, click the `3aebf1885b` **add rate limiting** row in the
   sidebar. The graph panel is revealed (front-most tab) and selection/detail/centering move to
   `3aebf1885b7d` — same round trip as step 4, now via the already-`ready` webview (immediate
   `selectNode`, no reopen).
6. Click the sidebar's **↻ alembic upgrade head** button. Nothing runs yet (Task 16 wires
   execution) — check the Output channel (**Alembic Graph**) for `sidebar: not implemented yet:
   upgrade` rather than a silent no-op or an error.
7. Collapse the Alembic Migrations view (click its header) and re-expand it. The heads/current/
   problems content re-renders correctly (a fresh `ready` → `state` round trip — WebviewView has no
   `retainContextWhenHidden`, so this is a real rebuild, not a hidden tab resuming).
8. Open webview DevTools for the sidebar (**Developer: Open Webview Developer Tools** while the
   sidebar view has focus, or use the Command Palette while it's visible) and confirm the Console
   has no errors/CSP violations while repeating steps 2–6.
9. Repeat steps 1–2 with the **Run Extension (healthy fixture)** launch config: **▾ HEADS** shows a
   `2` pill with two rows, **PROBLEMS** shows dim `No problems` (no broken links in that fixture).
10. No-project mode: open VS Code on a workspace folder with no `alembic.ini` anywhere in it (e.g.
    an empty temp folder, not `--extensionDevelopmentPath`'s target — use **File: Open Folder…**
    inside a plain Extension Development Host launched without either fixture argument, or edit
    `.vscode/launch.json` temporarily). Click the Alembic icon in the activity bar (this is what
    activates the extension via VS Code's implicit `onView` activation — no `alembic.ini` means the
    `workspaceContains` activation event never fires on its own). The sidebar shows the client-side
    empty state: "No alembic.ini found in this workspace" + the dim hint line, with no console
    errors.
