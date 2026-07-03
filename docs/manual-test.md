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

## Task 13: alembic CLI runner + async applied-state enrichment

Setup: the Extension Development Host resolves the alembic command as override setting →
ms-python active interpreter (`python -m alembic`) → bare `alembic` on PATH. Unless you have the
ms-python extension pointed at this repo's `.venv` inside the fixture workspace, the simplest
deterministic setup is the override: in the Extension Development Host, open **Preferences: Open
Workspace Settings (JSON)** and set

```json
"alembicGraph.alembicCommand": "<absolute repo path>/.venv/bin/python -m alembic"
```

(the override is whitespace-split, so it must not contain paths with spaces). Remove it when done.
`alembic current` against the sqlite fixtures auto-creates a `fixtures/*/fixture.db` — it's
gitignored, but delete it after testing so future runs start from "nothing applied".

1. Press F5, select **Run Extension (healthy fixture)**, set the override (above), run **Alembic
   Graph: Refresh**, and watch the **Alembic Graph** Output channel. After the usual `scan:` +
   JSON pair, expect a `$ …/.venv/bin/python -m alembic current (<path>/fixtures/healthy-project)`
   line, an `  exit 0`, alembic's INFO stderr lines, and a SECOND JSON state dump with
   `"dbReachable":true` (phase-2 enrichment). No revisions are applied yet (fresh DB), so:
   status bar still has no `current:` item, sidebar CURRENT REVISION still shows hollow-dot
   `unknown`-style empty state, and every graph card now shows a dim stripe + `not applied` in its
   meta row (applied is a definite *false* now, not unknown).
2. In a terminal at `fixtures/healthy-project`, run
   `../../.venv/bin/python -m alembic upgrade heads`, then run **Alembic Graph: Refresh** in the
   Extension Development Host. Expect:
   - Status bar gains a `current: <hash>` item showing the first of the two current heads
     (`4bfc02996c` or `3aebf1885b` — alembic's output order isn't guaranteed).
   - Graph cards: filled applied dots / bright hashes on ALL cards (everything is an ancestor of
     the two heads), and a green **CURRENT** badge on both `3aebf1885b7d` and `4bfc02996c8e`.
   - Click a card: the detail panel's `status` row reads **Applied** (not `Unknown`), and
     **Applied · Current** styling on the two head cards' details (`isCurrent: true`).
   - Sidebar: CURRENT REVISION section shows a filled dot + the same first-current-head hash as
     the status bar.
3. Downgrade partially: `../../.venv/bin/python -m alembic downgrade d4c7f5309b2e`, then Refresh.
   The four base cards (`8f2a…`, `b2e5…`, `c3d6…`, `d4c7…`) keep filled dots, `d4c7f5309b2e` gains
   the CURRENT badge, and everything newer shows `not applied` + dim stripe.
4. The refresh is two-phase and never blocked by the CLI: immediately after clicking Refresh the
   graph re-renders instantly (dbReachable false for a beat), then the enriched state lands a
   moment later when `alembic current` returns. With a slow/hung alembic this would simply stay in
   phase 1 — the graph must never wait on it.
5. Broken fixture degradation (the golden rule): switch to **Run Extension (broken fixture)** (set
   the override in that workspace too). Everything renders exactly as before Task 13 — 13 layout
   nodes, ghost card, badges, sidebar problems — with hollow applied dots (`applied: null`,
   detail `status Unknown`), NO `current:` status bar item, and NO error toast/modal anywhere.
   The Output channel shows the `$ … alembic current` attempt followed by alembic's own crash
   traceback (KeyError: 'deadbeef0000') — logged, silent, `"dbReachable":false` in the state dump.
6. Bad override degradation: set `"alembicGraph.alembicCommand": "definitely-not-a-real-binary"`
   and Refresh on either fixture. Same silent degradation: graph renders, Output shows the
   attempted command + an ENOENT error, no user-facing error.
7. Cleanup: remove the override settings and delete `fixtures/*/fixture.db`.

## Task 14: drag-to-merge heads + mergeHeads QuickPick

`harness/graph.html` (after `npm run build`, served over http — see the file's header comment)
covers the pointer mechanics in isolation: drag threshold, target-ring hit-testing, transform-based
follow, revert-on-empty-drop, non-head/busy gating, Escape-cancel, and the posted `{type:"merge",
a, b}` message (recorded into `window.__postedMerges`; `window.__sendBusy(operation, active)`
simulates the host's busy round trip). The steps below are the F5-only checks that harness can't
cover: a real `alembic merge` subprocess, the input box, the busy toast/spinner round trip, a real
file-watcher-triggered re-render, and the command-palette QuickPick flow.

Setup: same override as Task 13 — in the Extension Development Host, **Preferences: Open Workspace
Settings (JSON)** →
`"alembicGraph.alembicCommand": "<absolute repo path>/.venv/bin/python -m alembic"`. **Fixture
mutations from this section must be reverted** — run `git checkout -- fixtures/` (and delete any
stray `fixtures/*/fixture.db`) once you're done, before committing or handing off.

1. Press F5, select **Run Extension (healthy fixture)** (2 heads: `3aebf1885b7d`/`4bfc02996c8e`),
   set the override, then **Alembic Graph: Open Migration Graph**.
2. Drag the `3aebf1885b7d` **add rate limiting** card by its header (not the message/meta text —
   anywhere on the card works) toward the `4bfc02996c8e` **search index (experimental)** card.
   Confirm, while the pointer is over it: the target card gets a bright green ring/glow, the
   dragged card gets a drop shadow and follows the cursor exactly, the cursor is a closed hand.
   Drop it there (release over the target).
3. An input box appears, pre-filled `merge heads 3aebf188 and 4bfc0299`, prompt "Merge revision
   message". Accept the default (Enter). Expect: the toolbar shows a small spinning `⟳ working…`
   indicator briefly, then a green success toast bottom-right reading `Merge revision created —
   Generating <path> ... done`; a new file appears under
   `fixtures/healthy-project/alembic/versions/` (check in a terminal or the Explorer); the graph
   re-renders with exactly **one** head (the new merge revision, badges HEAD + MERGE) — the file
   watcher picks up the new file with no manual refresh needed.
4. Run `git checkout -- fixtures/healthy-project` in a terminal, then **Alembic Graph: Refresh** —
   back to 2 heads.
5. Repeat step 2, but this time press **Escape** while the drop target's green ring is showing
   instead of releasing normally: the card snaps back to its origin, no input box, no toast, no new
   file.
6. Repeat step 2, but drop on empty canvas (not on the other head card): the card snaps back to its
   origin cleanly, no input box, no toast, no new file.
7. Repeat step 2's drag, but this time in the input box press **Escape** (cancel) instead of
   accepting: no toast, no busy spinner, no new file — confirm via the Output channel
   (**Alembic Graph**) that nothing was logged for this attempt (a cancelled prompt is silent by
   design).
8. Try dragging a non-head card (e.g. `8f2a1c9d4e07`): no shadow, no follow, nothing happens —
   plain click-to-select on it still works normally.
9. Command palette flow: run **Alembic Graph: Merge Heads…**. A multi-select QuickPick lists both
   heads (10-char hash label, message description). Select only **one** and confirm: a warning
   toast-style message "select exactly 2 heads..." appears and the QuickPick re-opens. Select
   **both**, confirm: same input box → busy → success toast → one-head graph flow as steps 2–3.
   `git checkout -- fixtures/healthy-project` again afterward.
10. With the graph panel **closed**, run **Alembic Graph: Merge Heads…** again and complete a
    merge: the input box, busy state, and success/error toasts all still work correctly even
    though `postToPanel` has nothing to post to (no panel-related errors in the Output channel).
    `git checkout -- fixtures/healthy-project` again afterward.
11. Failure path: temporarily set `"alembicGraph.alembicCommand"` to an invalid value (e.g.
    `"definitely-not-a-real-binary"`), repeat step 2's drag-and-drop, accept the input box: expect
    a red error toast (truncated CLI error text) AND a modal error message "alembic merge failed —
    see Alembic Graph output", and the Output channel shows the attempted command + ENOENT. Restore
    the override afterward.
12. Open webview DevTools (**Developer: Open Webview Developer Tools**) and confirm the Console has
    no errors/CSP violations while repeating steps 2–3.
13. Repeat steps 1–3 with the **Run Extension (broken fixture)** launch config (3 heads;
    `3aebf1885b7d`/`4bfc02996c8e` are two of them) — same drag/merge behavior, now down to 2 heads
    afterward (`5c0d13aa7d9f` remains). `git checkout -- fixtures/broken-project` afterward.
14. Final cleanup: confirm `git status` shows no stray changes under `fixtures/` and no
    `fixtures/*/fixture.db` files remain, then remove the `alembicCommand` override setting.

## Task 15: ghost-drag repoint

`harness/graph.html` (after `npm run build`, served over http) covers the pointer mechanics again,
same as Task 14: the broken-project fixture it's dumped from (`node scripts/dump-state.mjs`) has
exactly one ghost (`deadbeef0000`) whose only child (`5c0d13aa7d9f`) is ALSO a head, so it exercises
both drag-source rules at once — dragging the ghost card is a repoint drag (blue ring on every real
revision card, `window.__postedRepoints`), while dragging the `5c0d13aa7d9f` card is still a MERGE
drag (green ring, `window.__postedMerges`) because heads win even when broken. The steps below are
the F5-only checks that harness can't cover: a real text edit landing on disk, the file-watcher-
triggered rescan, the Problems/diagnostics side effects, and a real `alembic heads` recovering.

Setup: same override as Task 13/14 — in the Extension Development Host, **Preferences: Open
Workspace Settings (JSON)** →
`"alembicGraph.alembicCommand": "<absolute repo path>/.venv/bin/python -m alembic"`. **Fixture
mutations from this section must be reverted** — run `git checkout -- fixtures/` (and delete any
stray `fixtures/*/fixture.db`) once you're done, before committing or handing off.

1. Press F5, select **Run Extension (broken fixture)** (3 heads: `3aebf1885b7d`, `4bfc02996c8e`,
   `5c0d13aa7d9f`; 1 problem), set the override, then **Alembic Graph: Open Migration Graph**.
2. Find the dashed red **⚠ missing revision** ghost card (hash `deadbeef0000`) and the
   `5c0d13aa7d9f` **add audit log** card just below it — it shows both `HEAD` and `BROKEN` badges
   and the pulsing hint "⚠ down_revision missing — drag onto a parent to re-point".
3. Drag the ghost card (grab anywhere on it) toward the `4bfc02996c8e` **search index
   (experimental)** card. Confirm, while dragging: EVERY real revision card on the canvas (not just
   the one under the cursor) shows a blue ring/glow (`#4aa3ff`), the ghost card itself gets a drop
   shadow and follows the cursor exactly, ghosts/collapse cards are never ringed. Drop it onto
   `4bfc02996c8e` (release over the target).
4. Expect, with NO input box (unlike merge — there's nothing to confirm): the toolbar shows the
   `⟳ working…` indicator briefly, then a green success toast reading `Re-pointed down_revision →
   4bfc0299… · broken link fixed`. The file watcher picks this up with no manual refresh: the ghost
   card disappears, `5c0d13aa7d9f`'s `BROKEN` badge and hint are gone, the heads count drops from 3
   to 2 (`4bfc02996c8e` is no longer a head — `5c0d13aa7d9f` now revises it), and the toolbar's
   heads chip / problems count both update.
5. In a terminal, from `fixtures/broken-project`, run
   `../../.venv/bin/python -m alembic heads` — confirm it now SUCCEEDS (no traceback) and lists
   exactly two heads: `3aebf1885b7d` and `5c0d13aa7d9f`. Inspect
   `fixtures/broken-project/alembic/versions/5c0d13aa7d9f_add_audit_log.py` in the editor: only the
   `down_revision` value and the docstring's `Revises:` line changed (now `4bfc02996c8e`) — every
   other line, including the `upgrade()`/`downgrade()` bodies, is byte-for-byte unchanged.
6. Run `git checkout -- fixtures/broken-project` in a terminal, then **Alembic Graph: Refresh** —
   back to 3 heads, 1 problem, ghost card back.
7. Repeat step 3, but this time press **Escape** while the blue rings are showing instead of
   releasing normally: the ghost card snaps back to its origin, no toast, no busy spinner, the file
   on disk is untouched (`git status` shows nothing under `fixtures/`).
8. Repeat step 3, but drop on empty canvas (not on any real revision card): the ghost card snaps
   back to its origin cleanly, no toast, no file change.
9. Drag the `5c0d13aa7d9f` card itself (not the ghost) toward `3aebf1885b7d`: confirm it behaves
   exactly like Task 14's merge drag — GREEN ring (not blue), a merge input box on drop, NOT a
   repoint. This is the "heads win" rule: `5c0d13aa7d9f` is broken but also a head, so it's a merge
   source, and the ghost card is the only handle that can repair `deadbeef0000`.
10. Cycle-guard failure path: with the graph back to its original broken state (step 6), open
    `fixtures/broken-project/alembic/versions/5c0d13aa7d9f_add_audit_log.py` and temporarily change
    its `down_revision` to reference a ghost id whose only child chains back to a real descendant
    (e.g. point some other revision's `down_revision` at a new fake missing id, then drag that new
    ghost onto one of ITS OWN broken child's descendants) — expect a red error toast reading
    `re-pointing would create a cycle` and no file change. (Simpler alternative: trust the unit
    tests in `test/unit/migrationService.test.ts`'s `getRepointPlan` suite, which cover this guard
    directly — this step is optional if short on time.) `git checkout -- fixtures/broken-project`
    afterward regardless.
11. Open webview DevTools (**Developer: Open Webview Developer Tools**) and confirm the Console has
    no errors/CSP violations while repeating steps 3–4.
12. Final cleanup: confirm `git status` shows no stray changes under `fixtures/` and no
    `fixtures/*/fixture.db` files remain, then remove the `alembicCommand` override setting.

## Task 16: upgrade with modal confirm + offline SQL preview + busy-gating polish

`harness/graph.html` and `harness/sidebar.html` (after `npm run build`, served over http) cover the
webview-side busy polish in isolation: the drop guard now clears ONLY on a merge/repoint
`busy:false` (an unrelated op's busy/toast leaves it armed — verified via `window.__sendBusy` +
a real drag), and the sidebar's footer button disables (dim, `⟳ working…`, no post) while any
`__sendBusy` op is active. The steps below are the F5-only checks the harness can't cover: the real
modal, a real `alembic upgrade` mutating a real sqlite DB, the untitled SQL editor, and the
cross-webview busy broadcast.

Setup: same override as Task 13–15 — in the Extension Development Host, **Preferences: Open
Workspace Settings (JSON)** →
`"alembicGraph.alembicCommand": "<absolute repo path>/.venv/bin/python -m alembic"`. **A real
Upgrade writes `fixtures/healthy-project/fixture.db`** (gitignored but must not linger) — when
done, run `git checkout -- fixtures/` and delete any `fixtures/*/fixture.db` before committing or
handing off.

1. Press F5, select **Run Extension (healthy fixture)**, set the override, then open the Alembic
   activity-bar sidebar. Click the **↻ alembic upgrade head** footer button. A MODAL warning
   appears: "Run alembic upgrade heads? This modifies the database." with **Upgrade** and
   **Preview SQL** buttons (plus Cancel).
2. Click **Preview SQL**: no DB is touched — an untitled editor tab opens with `language: sql`
   containing the full DDL script (`CREATE TABLE alembic_version`, `CREATE TABLE products`, …,
   both branches' statements). Confirm NO `fixtures/healthy-project/fixture.db` was created
   (`ls` in a terminal) — offline mode never opens a connection. Close the tab (don't save).
3. Click the button again, this time press **Escape** (or Cancel): nothing happens — no toast, no
   busy flicker, no editor, no DB file, nothing in the Output channel for the attempt.
4. Click the button again, click **Upgrade**: the sidebar button dims to `⟳ working…` (and the
   graph panel's toolbar, if open, shows the same busy spinner — the broadcast reaches both), then
   a green success toast `Upgraded to heads` appears in the graph panel (open it via the graph icon
   if you want to watch), and the state refreshes on its own: every card gains the filled applied
   dot, `3aebf1885b7d` and `4bfc02996c8e` both gain the green **CURRENT** badge, the sidebar's
   CURRENT REVISION section shows a filled dot + hash, and the status bar gains `current: <hash>`.
   `fixtures/healthy-project/fixture.db` now exists.
5. With the graph panel open, run the command **Alembic Graph: Upgrade to Head** (Command
   Palette): same modal → same flow (it replaced the Task 6 stub). Clicking **Upgrade** again on an
   already-upgraded DB still succeeds (alembic no-ops) with the same toast.
6. Failure path: temporarily set `"alembicGraph.alembicCommand"` to
   `"definitely-not-a-real-binary"`, click the sidebar button, click **Upgrade**: red error toast
   (truncated error text) in the graph panel + modal error "alembic upgrade failed — see Alembic
   Graph output"; Output shows the attempted command + ENOENT; the sidebar button re-enables (busy
   cleared in the finally). Repeat choosing **Preview SQL**: analogous "alembic upgrade --sql
   failed" path, no editor opens. Restore the override.
7. Busy gating across webviews: start a **real** Upgrade (step 4) and, while the `⟳ working…`
   spinner is up, confirm the sidebar button ignores clicks (dim, no pointer cursor, no second
   modal) and dragging a head card in the graph panel does nothing. Both re-enable when the toast
   lands. (The run is quick against sqlite — re-run `git checkout` + delete fixture.db between
   attempts if you need a longer window, or just trust the harness checks above.)
8. Merge-cancel lockout fix (Task 14 carry-over): in the graph panel drag one head onto the other,
   then press **Escape** in the merge input box. Immediately drag the same head again: the drag
   starts right away (previously the webview's silent drop guard locked dragging out for up to
   30s after a cancelled input box).
9. Open webview DevTools for both webviews and confirm no errors/CSP violations while repeating
   steps 2–4.
10. Final cleanup: `git checkout -- fixtures/`, delete `fixtures/*/fixture.db`, confirm
    `git status` is clean, and remove the `alembicCommand` override setting.

## Task 17: revision context menu + downgrade + new revision + copy id

`harness/graph.html` (after `npm run build`, served over http) covers the webview-side mechanics
in isolation: the right-click menu's 5 items + separator, item clicks posting
`upgradeTo`/`downgradeTo`/`previewSql`/`copyId`/`openFile` (recorded in `window.__postedActions`),
Escape/click-elsewhere/scroll/state-push dismissal, no menu on ghost cards or while busy
(`window.__sendBusy`), right-click never arming a drag, position clamping at the window edge, and
the `+ New revision` toolbar button (posts `newRevision`, disabled while busy). The steps below are
the F5-only checks the harness can't cover: the real modal/QuickPick/input box, a real
`alembic downgrade`/`alembic revision` subprocess, the OS clipboard, and the file watcher picking
up a generated revision file.

Setup: same override as Task 13–16 — in the Extension Development Host, **Preferences: Open
Workspace Settings (JSON)** →
`"alembicGraph.alembicCommand": "<absolute repo path>/.venv/bin/python -m alembic"`. **A real
Downgrade writes `fixtures/healthy-project/fixture.db`, and a real New revision writes a new
`versions/*.py` file** — when done, run `git checkout -- fixtures/`, delete any untracked
`fixtures/*/alembic/versions/*.py` leftovers (`git clean -n fixtures/` to preview), and delete
`fixtures/*/fixture.db` before committing or handing off.

1. Press F5, select **Run Extension (healthy fixture)**, set the override, then **Alembic Graph:
   Open Migration Graph**. Right-click any revision card (e.g. `d4c7f5309b2e` **add password reset
   flow**): the card gets the blue selected ring + its detail panel opens (same as a left click),
   and a dark VS Code-style context menu appears at the pointer with, in order: **Upgrade to this
   revision**, **Downgrade to this revision**, **Preview SQL**, a separator, **Copy revision id**,
   **Open file**. Press **Escape**: the menu closes, nothing runs.
2. Right-click near the window's right/bottom edge: the menu stays fully inside the window
   (clamped), never cut off.
3. **Copy revision id**: right-click `d4c7f5309b2e` → **Copy revision id**. An info toast `Copied
   d4c7f5309b2e` appears bottom-right; paste anywhere (Cmd+V) and confirm the full id landed on
   the OS clipboard.
4. **Open file**: right-click a card → **Open file**: the revision's real source file opens in an
   editor tab (same handler as the detail panel's file row).
5. **Preview SQL**: right-click `d4c7f5309b2e` → **Preview SQL**: an untitled `sql` editor opens
   with the DDL up to THAT revision only (`create products/users/sessions/password_reset` — no
   statements from revisions above it). No `fixture.db` is created (offline mode). Close the tab.
6. **Upgrade to this revision**: right-click `d4c7f5309b2e` → **Upgrade to this revision**: the
   Task 16 modal appears naming the target (`Run alembic upgrade d4c7f5309b2e? ...`) with
   **Upgrade** / **Preview SQL** buttons. Click **Upgrade**: busy spinner → green toast `Upgraded
   to d4c7f5309b2e` → the four base cards (`8f2a…`, `b2e5…`, `c3d6…`, `d4c7…`) gain filled applied
   dots and `d4c7f5309b2e` gains the CURRENT badge.
7. **Downgrade**: right-click `8f2a1c9d4e07` **create products table** → **Downgrade to this
   revision**. A MODAL warning appears: `Run alembic downgrade 8f2a1c9d? This modifies the
   database.` with a single **Downgrade** button (no Preview SQL here — offline downgrade needs a
   range, out of scope). Press **Escape** first: nothing happens (no toast, no busy, nothing
   logged). Repeat and click **Downgrade**: busy spinner → green toast `Downgraded to 8f2a1c9d` →
   only `8f2a1c9d4e07` keeps the applied dot + CURRENT badge, everything newer shows `not applied`.
8. Busy gating: while a downgrade/upgrade is in flight (the `⟳ working…` spinner), right-click a
   card: no menu appears (the browser default menu is also suppressed on cards); the `+ New
   revision` button is dimmed and ignores clicks. Both recover when the toast lands.
9. **New revision (empty)**: click the toolbar's **+ New revision** button (right of the density
   toggles). An input box prompts "New revision message" — confirm empty input is rejected
   ("Revision message is required") and **Escape** cancels silently. Enter `manual test revision`,
   then in the QuickPick pick **Empty revision**. NOTE: on this 2-head fixture alembic refuses
   with a red toast `FAILED: Multiple heads are present; ...` (readable, not a generic "Command
   failed") — that's the expected multi-head behavior. To see the success path, first merge the
   two heads (Task 14 drag), then repeat: green toast `Revision created`, a new file appears under
   `versions/`, and the graph re-renders with the new revision as head (file watcher, no manual
   refresh).
10. **New revision (autogenerate failure path)**: click **+ New revision** again, same message,
    pick **Autogenerate from models (--autogenerate)**. The fixture has no target metadata/env
    configured for autogenerate against an out-of-date DB, so expect the NORMAL failure: a red
    error toast with alembic's own readable message (e.g. `Target database is not up to date.` —
    not a bare exit code), a modal "alembic revision failed — see Alembic Graph output", and the
    full stderr in the Output channel. No file is created.
11. Open webview DevTools and confirm no errors/CSP violations while repeating steps 1–10.
12. Final cleanup: `git checkout -- fixtures/`, `git clean -f fixtures/` (removes any generated
    merge/revision files), delete `fixtures/*/fixture.db`, confirm `git status` is clean, and
    remove the `alembicCommand` override setting.

## Task 18: Problems-panel diagnostics + "Show in Migration Graph" CodeLens

`buildFileDiagnostics` (src/core/diagnostics.ts) is fully covered by
`test/unit/diagnostics.test.ts`; the CodeLens provider's line-finding reuses the already-tested
`parseRevisionSource`. The steps below are the F5-only checks that need a real Problems panel, a
real CodeLens, and a real file-watcher-triggered clear — nothing here is reachable from vitest.

1. Press F5, select **Run Extension (broken fixture)**, then **Alembic Graph: Open Migration
   Graph** (not required for diagnostics, but useful for step 5's drag).
2. Open **View → Problems** (or `Cmd+Shift+M`). Expect exactly one error row: source
   `alembic-graph`, file `5c0d13aa7d9f_add_audit_log.py`, message
   `` `5c0d13aa7d9f` revises missing revision `deadbeef0000` — drag the ghost node onto a real
   revision in the Migration Graph to repair ``. Double-click the row: the file opens with the
   cursor on the `down_revision = "deadbeef0000"` line (the whole line is underlined/squiggled,
   not just the value).
3. In the Explorer, expand `fixtures/broken-project/alembic/versions/` — the same file shows a red
   underline badge (error count `1`) on its own row, and the `versions` folder/`alembic`/project
   root each roll up an error badge too (VS Code's own aggregation, nothing this task does
   directly).
4. Open `5c0d13aa7d9f_add_audit_log.py` in an editor tab. Just above the `revision = "5c0d13aa7d9f"`
   line, expect a CodeLens reading `◈ Show in Migration Graph`. Click it: the "Migration Graph"
   panel opens (or is revealed if already open) with the `5c0d13aa7d9f` card selected (blue
   ring/background) and the canvas scrolled so it's roughly centered — same round trip as a sidebar
   head-row click (Task 12).
5. Open a few other files under the same `versions/` dir (e.g.
   `8f2a1c9d4e07_create_products_table.py`): each shows its own `◈ Show in Migration Graph` lens
   above its `revision =` line, clicking selects/centers that card. Open any file OUTSIDE the
   versions dir (e.g. `fixtures/broken-project/alembic/env.py`, or this repo's own `package.json`):
   no lens appears there.
6. With the graph panel open, drag the ghost card (`deadbeef0000`, dashed red) onto a real revision
   card to repoint it (same drag as Task 15's manual test). Within ~1s of the file-watcher-triggered
   rescan: the Problems panel's single error row disappears entirely (panel/badge go back to empty),
   and `5c0d13aa7d9f_add_audit_log.py`'s CodeLens is unaffected (still shows, since the file itself
   is still a valid revision). Run `git checkout -- fixtures/broken-project` afterward to restore
   the broken link for future manual-test runs.
7. Repeat step 6's setup by re-breaking the link (`git checkout` already restored it) — introduce a
   duplicate id instead: copy `8f2a1c9d4e07_create_products_table.py` to a new file in the same
   `versions/` dir and leave its `revision = "8f2a1c9d4e07"` line unchanged. Within ~1s: the
   Problems panel now shows entries for BOTH files at the `revision =` line of each (no drag hint —
   that suffix is broken-only), and each file's own `◈ Show in Migration Graph` CodeLens still
   resolves to the SAME `8f2a1c9d4e07` card (first-by-filePath wins, same rule `graph.ts`'s
   `buildGraph` already applies — see `test/unit/graph.test.ts` test 6). Delete the copy afterward
   (`git clean -f fixtures/broken-project` or delete the file directly) and confirm `git status` is
   clean under `fixtures/`.
8. Repeat steps 1–5 with the **Run Extension (healthy fixture)** launch config: Problems panel is
   empty (no diagnostics), and every `versions/*.py` file still shows its own
   `◈ Show in Migration Graph` CodeLens.
9. Command Palette: run **Alembic Graph: Show in Migration Graph** directly (no CodeLens click).
   Confirm it does nothing observable (no error, no panel change) — this command is designed to be
   invoked with a revision id argument (from the CodeLens only), not bare from the palette.
10. No-project mode: open a workspace with no `alembic.ini` (see Task 12 step 10's setup) and run
    **Alembic Graph: Show in Migration Graph** from the Command Palette: the friendly stub toast
    "Alembic Graph: Show in Migration Graph — not implemented yet" appears, same as the other
    not-yet-resolved commands.
