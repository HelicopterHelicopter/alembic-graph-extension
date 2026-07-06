#!/usr/bin/env node
/**
 * Generates harness/state.json AND harness/details.json by running the REAL
 * `MigrationService` (src/services/migrationService.ts, unmodified — it's host-agnostic by
 * design: no `vscode` import) over fixtures/broken-project, with fake deps that read from disk
 * instead of `vscode.workspace.fs`. `service.refresh()` + `service.getState()` produce
 * harness/state.json exactly the way the real extension host would; `service.getDetail(id)` per
 * revision id produces harness/details.json exactly the way `GraphPanelManager`'s "select" case
 * would. Using the real service (rather than hand-reassembling AppState/RevisionDetail from
 * core/graph|layout|parser output, as an earlier version of this script did) means these two
 * JSON files can never silently drift from what MigrationService actually returns.
 *
 * `MigrationService` and `src/core/*.ts` are plain TypeScript, so they can't be
 * `require`d/`import`ed directly by plain Node. This script bundles a small inline entry (via
 * esbuild's JS API, `stdin` input so no throwaway .ts file is needed) and runs the bundled JS in
 * a temp file.
 *
 * Usage: `node scripts/dump-state.mjs` (re-run after touching core/parser|graph|layout.ts,
 * services/migrationService.ts, or the broken-project fixture; harness/state.json +
 * harness/details.json are checked in so `harness/graph.html` works without a build step of its
 * own).
 */
import esbuild from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

// Imports below are relative to `resolveDir` (repoRoot, set on the esbuild stdin input) so they
// resolve exactly like every other import in this codebase.
const entrySource = `
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MigrationService } from "./src/services/migrationService";

const repoRoot = ${JSON.stringify(repoRoot)};
const versionsDir = path.join(repoRoot, "fixtures/broken-project/alembic/versions");
const files = readdirSync(versionsDir).filter((f) => f.endsWith(".py"));

let ui = { order: "newest-bottom", density: "comfortable", expandCollapsed: false, axis: "horizontal" };

const service = new MigrationService({
  async listVersionFiles() {
    return files.map((file) => ({
      // Deliberately the bare filename, not a full path: keeps harness/*.json identical across
      // machines/users (nothing in the renderer reads filePath as an actual filesystem path).
      path: file,
      content: readFileSync(path.join(versionsDir, file), "utf8"),
    }));
  },
  getConfig() {
    return { laneColorA: "#4aa3ff", laneColorB: "#c586c0", showSqlPreview: true, collapseThreshold: 20 };
  },
  getUiPrefs() {
    return ui;
  },
  setUiPrefs(prefs) {
    ui = prefs;
  },
  log() {},
  project: {
    label: "broken-project / alembic",
    iniPath: "fixtures/broken-project/alembic.ini",
    versionsDir: "fixtures/broken-project/alembic/versions",
  },
});

await service.refresh();
const state = service.getState();

const outPath = path.join(repoRoot, "harness/state.json");
writeFileSync(outPath, JSON.stringify(state, null, 2) + "\\n");
console.log(
  "wrote harness/state.json —",
  state.layout.nodes.length, "nodes,",
  state.layout.edges.length, "edges,",
  state.counts.heads, "heads,",
  state.counts.revisions, "revisions",
);

// One real getDetail() result per real revision id (ghost/collapse layout nodes have no graph
// node, so getDetail — and therefore this map — never has entries for them; harness/graph.html's
// fake vscodeApi treats a missing key as detail: null, matching GraphPanelManager exactly).
const detailsById = {};
for (const node of state.layout.nodes) {
  if (node.kind !== "revision") continue;
  detailsById[node.id] = service.getDetail(node.id);
}

const detailsOutPath = path.join(repoRoot, "harness/details.json");
writeFileSync(detailsOutPath, JSON.stringify(detailsById, null, 2) + "\\n");
console.log("wrote harness/details.json —", Object.keys(detailsById).length, "revisions");
`;

const result = await esbuild.build({
  stdin: {
    contents: entrySource,
    resolveDir: repoRoot,
    sourcefile: "dump-state-entry.mjs",
    loader: "js",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});

const tmpDir = mkdtempSync(path.join(tmpdir(), "alx-dump-"));
const tmpFile = path.join(tmpDir, "entry.mjs");
writeFileSync(tmpFile, result.outputFiles[0].text);
try {
  await import(pathToFileURL(tmpFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
