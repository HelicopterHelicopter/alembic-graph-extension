---
name: run-alembic-graph-extension
description: Build, run, and drive the Alembic Graph VS Code extension in a real Extension Development Host. Use when asked to run or launch the extension, sanity-check UI changes live, screenshot the sidebar or migration graph, or verify sidebar/status-bar/graph behavior in VS Code.
---

A VS Code extension (activity-bar sidebar + graph webview + status bar). Drive it via
`.claude/skills/run-alembic-graph-extension/driver.mjs`, which launches VS Code's own
Electron binary as an Extension Development Host, connects Playwright over CDP, clicks
the Alembic activity-bar icon, screenshots the sidebar, prints the status bar and sidebar
webview text, opens the Migration Graph panel, and screenshots it. All paths are relative
to the repo root.

Verified on macOS with VS Code installed at `/Applications/Visual Studio Code.app`. On
another install, point `VSCODE_ELECTRON` at the Electron binary inside VS Code.

## Prerequisites

- VS Code at `/Applications/Visual Studio Code.app` (or set `VSCODE_ELECTRON`).
- Node + repo dependencies installed.
- Optional but recommended: the repo's `.venv` (has `alembic`) — the fixture workspaces
  symlink it so the extension's real CLI enrichment (`alembic current`) runs.

```bash
npm install
npm install --no-save playwright-core   # AFTER npm install — npm install prunes unlisted packages
```

## Build

The dev host loads `dist/extension.js`, so build first or your changes aren't in the run:

```bash
npm run build
```

## Run (agent path)

Prepare a throwaway workspace from a fixture (never open `fixtures/` in place — the
extension's CLI enrichment writes `fixture.db` and `__pycache__` into the workspace),
then run the driver:

```bash
# Healthy fixture, with migrations applied -> exercises the real `alembic current`
# path and the multi-current display (this fixture has TWO heads):
WS=/private/tmp/alx-ws-healthy
rm -rf $WS && cp -R fixtures/healthy-project $WS && ln -sfn "$PWD/.venv" $WS/.venv
(cd "$WS" && ./.venv/bin/alembic upgrade heads)   # `upgrade head` FAILS here: multiple heads

node .claude/skills/run-alembic-graph-extension/driver.mjs $WS /private/tmp/alx-shot
```

```bash
# Broken fixture -> ghost node, problems list, CLI-failure degrade ("unknown" current):
WS=/private/tmp/alx-ws-broken
rm -rf $WS && cp -R fixtures/broken-project $WS && ln -sfn "$PWD/.venv" $WS/.venv
node .claude/skills/run-alembic-graph-extension/driver.mjs $WS /private/tmp/alx-shot-broken
```

Outputs:

- `<out-prefix>-sidebar.png`, `<out-prefix>-graph.png` — full-window screenshots. LOOK at them.
- `STATUSBAR: ...` on stdout — e.g. `" 2 heads | current: 4bfc02996c +1 | 11 revisions | ..."`.
- `SIDEBAR_TEXT: ...` on stdout — the sidebar webview's inner text (heads, current revisions,
  problems), read through the nested webview iframes.
- `DONE` and exit 0 on success; `DRIVER FAILED: ...` and exit 1 otherwise.

The driver kills its VS Code instance on exit. It uses an isolated profile under
`/private/tmp/alxvsc` — the user's real VS Code state is never touched.

## Run (human path)

Open the repo in VS Code and press F5 (standard extension debugging), or:

```bash
"/Applications/Visual Studio Code.app/Contents/MacOS/Electron" \
  --user-data-dir=/private/tmp/alxvsc/ud --extensions-dir=/private/tmp/alxvsc/ext \
  --extensionDevelopmentPath="$PWD" /private/tmp/alx-ws-healthy
```

A window opens; quit it manually. Useless for programmatic checks.

## Test

```bash
npm run check       # tsc over both tsconfigs (host + webview)
npm run test:unit   # vitest — 441 tests at time of writing
```

## Gotchas

- **Playwright's `_electron.launch` does NOT work with VS Code** — the app closes
  immediately (`firstWindow: Target page ... has been closed`). VS Code's patched Electron
  main doesn't speak Playwright's launch protocol. The working route is what the driver
  does: spawn with `--remote-debugging-port` and `chromium.connectOverCDP`, then find the
  CDP page whose URL contains `workbench.html`.
- **`--user-data-dir` must be a SHORT path.** VS Code binds a unix domain socket inside it;
  a deep path exceeds the ~103-char `sun_path` limit and VS Code dies at startup with
  `Error: listen EINVAL: invalid argument ...main.sock`. Hence `/private/tmp/alxvsc`.
- **`npm install` prunes `--no-save` packages.** Install `playwright-core` after, not
  before, any `npm install`/`npm ci`.
- **`alembic upgrade head` fails on the healthy fixture** — it has two heads by design.
  Use `upgrade heads` (plural).
- **Alembic's `INFO [alembic...]` logging goes to stderr**, stdout carries only revision
  lines — relevant when eyeballing `alembic current` output during workspace prep.
- **Webview text lives two iframes deep**: `iframe.webview.ready` (service-worker host)
  then `#active-frame`. The driver uses `.last()` for the sidebar since the graph panel's
  webview, if open, appears earlier in the DOM.
- **Build before running** — the dev host loads `dist/`, not `src/`; a stale build
  silently runs old code.

## Troubleshooting

- **`CDP endpoint never came up`**: VS Code exited at startup. Re-run the spawn line from
  "Run (human path)" with output visible; if the log shows `listen EINVAL ... .sock`, your
  profile dir path is too long (see Gotchas).
- **`workbench page not found over CDP`**: the window is slow on first-ever launch
  (extension host warm-up); re-run — the profile is warm the second time.
- **Sidebar shows "Scanning migrations…" in the screenshot**: the fixed waits in the
  driver were too short on a cold machine; bump the `waitForTimeout(5000)` after the
  activity-bar click.
