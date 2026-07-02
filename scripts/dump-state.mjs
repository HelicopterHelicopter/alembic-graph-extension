#!/usr/bin/env node
/**
 * Generates harness/state.json: runs the REAL parse -> graph -> layout pipeline (src/core/*.ts,
 * unmodified) over fixtures/broken-project and writes out the resulting AppState, built the same
 * way MigrationService.doRefresh() builds it (see src/services/migrationService.ts). This is the
 * ground truth harness/graph.html loads to render the graph outside VS Code.
 *
 * src/core/*.ts are plain TypeScript (no vscode import — see the purity comment at the top of
 * each), so they can't be `require`d/`import`ed directly by plain Node. This script bundles a
 * small inline entry (via esbuild's JS API, `stdin` input so no throwaway .ts file is needed) and
 * runs the bundled JS in a temp file.
 *
 * Usage: `node scripts/dump-state.mjs` (re-run after touching core/parser|graph|layout.ts or the
 * broken-project fixture; harness/state.json is checked in so `harness/graph.html` works without
 * a build step of its own).
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
import { parseRevisionSource } from "./src/core/parser";
import { buildGraph } from "./src/core/graph";
import { layoutGraph } from "./src/core/layout";

const repoRoot = ${JSON.stringify(repoRoot)};
const versionsDir = path.join(repoRoot, "fixtures/broken-project/alembic/versions");

const files = readdirSync(versionsDir).filter((f) => f.endsWith(".py"));
const revisions = files
  .map((file) => parseRevisionSource(readFileSync(path.join(versionsDir, file), "utf8"), file))
  .filter((r) => r !== null);

const graph = buildGraph(revisions);
const layout = layoutGraph(graph, {
  collapseThreshold: 20,
  expandCollapsed: false,
  appliedSet: null,
  currentIds: [],
});

const laneColorA = "#4aa3ff";
const laneColorB = "#c586c0";
const laneColors = Array.from(
  { length: Math.max(layout.laneCount, 1) },
  (_, i) => (i === 0 ? laneColorA : laneColorB),
);

const state = {
  project: {
    label: "broken-project / alembic",
    // Deliberately a repo-relative display string, not path.join(repoRoot, ...): iniPath isn't
    // read by the renderer, and this keeps harness/state.json identical across machines/users.
    iniPath: "fixtures/broken-project/alembic.ini",
  },
  layout,
  heads: graph.heads.map((id) => ({ id, message: graph.nodes[id].message })),
  currentIds: [],
  problems: graph.problems,
  dbReachable: false,
  laneColors,
  counts: {
    revisions: Object.keys(graph.nodes).length,
    heads: graph.heads.length,
    problems: graph.problems.length,
  },
  config: { showSqlPreview: true },
  ui: { order: "newest-bottom", density: "comfortable", expandCollapsed: false },
};

const outPath = path.join(repoRoot, "harness/state.json");
writeFileSync(outPath, JSON.stringify(state, null, 2) + "\\n");
console.log(
  "wrote harness/state.json —",
  state.layout.nodes.length, "nodes,",
  state.layout.edges.length, "edges,",
  state.counts.heads, "heads,",
  state.counts.revisions, "revisions",
);
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
