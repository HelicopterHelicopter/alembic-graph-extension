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
