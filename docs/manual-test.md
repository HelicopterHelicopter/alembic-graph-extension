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
