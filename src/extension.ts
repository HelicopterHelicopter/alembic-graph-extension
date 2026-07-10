import * as vscode from "vscode";
import { pickProject, selectProject, type AlembicProject } from "./services/discovery";
import { MigrationService, type MigrationServiceDeps } from "./services/migrationService";
import { AlembicCli, resolveCommand } from "./services/alembicCli";
import { getActivePythonPath } from "./services/pythonEnv";
import { createAuthorProvider, type AuthorProvider } from "./services/gitAuthor";
import { createGhostBlameProvider, type GhostBlameProvider } from "./services/gitDeletion";
import { DEFAULT_LANE_COLOR_A, DEFAULT_LANE_COLOR_B, isValidHex } from "./core/color";
import { createStatusBar } from "./ui/statusBar";
import { GraphPanelManager } from "./ui/graphPanel";
import { SidebarViewProvider } from "./ui/sidebarView";
import { createCodeLensProvider } from "./ui/codeLens";
import { mergeHeadsAction, upgradeAction, type ActionContext } from "./ui/actions";
import { createDiagnostics } from "./services/diagnostics";
import { shouldDeliverStale } from "./core/broadcastGate";
import type { HostToWebviewMessage, UiPrefs } from "./protocol/messages";

const SIDEBAR_VIEW_ID = "alembicGraph.sidebar";

const UI_PREFS_KEY = "alembicGraph.uiPrefs";
const DEFAULT_UI_PREFS: UiPrefs = {
  order: "newest-bottom",
  density: "comfortable",
  expandCollapsed: false,
  axis: "horizontal",
};

const NO_PROJECT_MESSAGE = "Alembic Graph: no Alembic project is active. Run \"Select Alembic Project…\" first.";

let outputChannel: vscode.OutputChannel;

/**
 * Everything ONE active project's pipeline consists of. A code-review pass on this task flagged
 * that spreading this same information across several independently-updated module `let`s (as an
 * earlier draft did) invites drift — a handler reading one of them could see a stale value while a
 * sibling already points at the new project. `currentPipeline` is now the SINGLE source of truth:
 * every accessor below reads through it, and `switchProject` is the only code that ever reassigns
 * the variable holding it.
 */
interface Pipeline {
  project: AlembicProject;
  service: MigrationService;
  cli: AlembicCli;
  /** Task B1's git-deletion-blame provider for this project's versionsDir — reachable here (like
   * `cli`) for Task B2's restore/import action, which needs `getRepoRoot()` alongside whatever
   * blame `service.getState()!.ghostBlame` already carries. */
  blameProvider: GhostBlameProvider;
  panelManager: GraphPanelManager;
  actionCtx: ActionContext;
  dispose(): void;
}

let currentPipeline: Pipeline | undefined;

/** Constructed once in activate() and registered exactly once as the `alembicGraph.sidebar`
 * webview view provider — see SidebarViewProvider.rebind()'s doc comment for why this can't be
 * recreated per project switch. */
let sidebarProvider: SidebarViewProvider;

/**
 * Bumped once per `activateForProject` call — each pipeline's `broadcast` closure captures the
 * value at its own construction time and checks it's still current before posting anything. A
 * code-review pass caught that without this, an action still in flight against a project that has
 * since been switched away from (e.g. an `alembic upgrade` the user kicked off right before
 * running "Select Alembic Project…") would, on completion, post its toast/busy message into
 * WHATEVER project is active by the time the CLI call resolves — `currentPipeline` having already
 * moved on by then — misattributing a stale result into the new project's panel/sidebar. Gating
 * broadcast on this counter makes a superseded pipeline's messages silent no-ops instead — with
 * one deliberate exception: a terminal `busy: {active:false}` is NEVER gated, even from a stale
 * epoch. See `shouldDeliverStale` (core/broadcastGate.ts) for why: `busy:true` posts synchronously
 * before the CLI await that can straddle a switch, so gating its matching `busy:false` the same
 * way would leave the sidebar's (persistent, never-torn-down) upgrade button wedged "working…" for
 * the rest of the session with no self-heal.
 */
let broadcastEpoch = 0;

/** Minimal accessor for later tasks (status bar, graph panel, sidebar) to hook onDidChangeState. */
export function getService(): MigrationService | undefined {
  return currentPipeline?.service;
}

/** Accessor for later tasks (14/16/17: merge/upgrade/downgrade/revision actions) that need to run
 * alembic CLI commands beyond `current` against the active project. */
export function getCli(): AlembicCli | undefined {
  return currentPipeline?.cli;
}

/** Task B2's counterpart to `getCli()`: the active project's `GhostBlameProvider`, for
 * `restoreDeletedAction`'s `getRepoRoot()` call — mirrors `getCli()` exactly (read fresh at call
 * time, undefined in no-project mode). */
export function getBlameProvider(): GhostBlameProvider | undefined {
  return currentPipeline?.blameProvider;
}

/**
 * Resolves the alembic command to run, fresh on every call (the override setting, the active
 * Python interpreter, and the project-local venv on disk can all change between calls — this must
 * never be cached). Precedence: a non-empty `alembicGraph.alembicCommand` override wins outright;
 * otherwise fall back to the ms-python extension's active interpreter (`python -m alembic`); then a
 * project-local `.venv`/`venv` discovered under `iniDir` or the first workspace folder
 * (`findProjectEnvCommand` — the common case where alembic is installed in the project but was
 * never explicitly selected as the active interpreter); then a bare `alembic` on PATH. Cheap even
 * though it's called fresh per run: at most a handful of `existsSync` calls.
 */
async function resolveAlembicCommand(iniDir: string) {
  const override = vscode.workspace.getConfiguration("alembicGraph").get<string>("alembicCommand", "");
  if (override.trim().length > 0) {
    return resolveCommand({ override, pythonPath: null, iniDir });
  }
  const pythonPath = await getActivePythonPath();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  return resolveCommand({ override: "", pythonPath, iniDir, workspaceRoot });
}

/** Builds the AlembicCli for `project`, rooted at its alembic.ini directory (the cwd alembic
 * itself expects to run from). */
function buildAlembicCli(project: AlembicProject): AlembicCli {
  return new AlembicCli({
    cwd: project.iniDir,
    resolve: () => resolveAlembicCommand(project.iniDir),
    log: (line) => outputChannel.appendLine(line),
  });
}

interface HeadQuickPickItem extends vscode.QuickPickItem {
  headId: string;
}

/**
 * `alembicGraph.mergeHeads` command body: needs at least 2 current heads, lets the user pick at
 * least 2 via a multi-select QuickPick (re-prompting on a sub-2 selection count — N-way task: 3+
 * is now a valid, intentional "octopus merge" selection, not just 2), then hands off to the same
 * `mergeHeadsAction` the graph panel's drag-and-drop / "Merge all N heads" button use.
 */
async function runMergeHeadsCommand(ctx: ActionContext): Promise<void> {
  const heads = ctx.service.getState()?.heads ?? [];
  if (heads.length < 2) {
    void vscode.window.showInformationMessage("Alembic Graph: need at least 2 heads to merge.");
    return;
  }

  const items: HeadQuickPickItem[] = heads.map((h) => ({
    label: h.id.slice(0, 10),
    description: h.message,
    headId: h.id,
  }));

  for (;;) {
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: "Select at least 2 heads to merge",
    });
    if (picked === undefined) return; // cancelled outright
    if (picked.length >= 2) {
      await mergeHeadsAction(ctx, picked.map((p) => p.headId));
      return;
    }
    void vscode.window.showWarningMessage(
      `Alembic Graph: select at least 2 heads to merge (${picked.length} selected).`,
    );
    // loop: re-prompt
  }
}

/** One-time-per-key warning tracker for `sanitizeLaneColor` below — an invalid setting logs once,
 * not on every config read (every refresh() calls getConfig()). */
const warnedInvalidColorKeys = new Set<string>();

/** Validates a lane color setting against `#rrggbb` at the point it's read out of VS Code
 * configuration (Task 20's review flagged this as a workspace-settings injection vector otherwise
 * — an arbitrary string could ride along into a CSS/SVG sink downstream). Falls back to
 * `fallback` and logs once per key when invalid. `laneColorsFor` (migrationService.ts) also
 * independently validates as a second line of defense, but THIS is the point closest to the
 * untrusted source. */
function sanitizeLaneColor(raw: string, fallback: string, key: string): string {
  if (isValidHex(raw)) return raw;
  if (!warnedInvalidColorKeys.has(key)) {
    warnedInvalidColorKeys.add(key);
    outputChannel.appendLine(`alembicGraph.${key}: "${raw}" is not a valid #rrggbb color — using default ${fallback}`);
  }
  return fallback;
}

/** Builds the vscode-backed MigrationServiceDeps for `project`. */
function buildDeps(
  context: vscode.ExtensionContext,
  project: AlembicProject,
  cli: AlembicCli,
  authorProvider: AuthorProvider,
  blameProvider: GhostBlameProvider,
): MigrationServiceDeps {
  return {
    async listVersionFiles() {
      const dirUri = vscode.Uri.file(project.versionsDir);
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      const pyFiles = entries.filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".py"));

      const files: { path: string; content: string }[] = [];
      for (const [name] of pyFiles) {
        const fileUri = vscode.Uri.joinPath(dirUri, name);
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        files.push({ path: fileUri.fsPath, content: new TextDecoder("utf-8").decode(bytes) });
      }
      return files;
    },
    getConfig() {
      const cfg = vscode.workspace.getConfiguration("alembicGraph");
      return {
        laneColorA: sanitizeLaneColor(cfg.get<string>("laneColorA", DEFAULT_LANE_COLOR_A), DEFAULT_LANE_COLOR_A, "laneColorA"),
        laneColorB: sanitizeLaneColor(cfg.get<string>("laneColorB", DEFAULT_LANE_COLOR_B), DEFAULT_LANE_COLOR_B, "laneColorB"),
        showSqlPreview: cfg.get<boolean>("showSqlPreview", true),
        // package.json declares `minimum: 3`, but VS Code only enforces that in the Settings UI —
        // a hand-edited settings.json (or an extension/task programmatically writing config) can
        // still hand back anything, including 0/negative/fractional. Clamped here, the point
        // closest to the untrusted source, same pattern as `sanitizeLaneColor` above; layout.ts's
        // `run.length > 1` guard is the second line of defense against a degenerate value ever
        // reaching `layoutGraph` some other way (e.g. a future caller that skips getConfig()).
        collapseThreshold: Math.max(3, cfg.get<number>("collapseThreshold", 20)),
      };
    },
    getUiPrefs() {
      return { ...DEFAULT_UI_PREFS, ...(context.workspaceState.get<UiPrefs>(UI_PREFS_KEY) ?? {}) };
    },
    setUiPrefs(prefs) {
      void context.workspaceState.update(UI_PREFS_KEY, prefs);
    },
    log(line) {
      outputChannel.appendLine(line);
    },
    project: { label: project.label, iniPath: project.iniPath, versionsDir: project.versionsDir },
    async fetchCurrent() {
      const result = await cli.current();
      return result.dbReachable ? { dbReachable: true, currentIds: result.currentIds } : { dbReachable: false, currentIds: [] };
    },
    async fetchAuthors(filePaths) {
      return authorProvider.lookup(filePaths);
    },
    async fetchGhostBlame(requests) {
      return blameProvider.lookup(requests);
    },
  };
}

/** Disposes `disposables` in order, wrapping EACH ONE in its own try/catch so a single disposable
 * throwing (e.g. a VS Code API object misbehaving) can't abort the loop and leave a LATER
 * disposable — notably the graph panel's `registerWebviewPanelSerializer` registration, which VS
 * Code only allows one live instance of per view type — never disposed. A future
 * `activateForProject` call would then throw trying to register a second one for the same view
 * type. Failures are logged, never rethrown. */
function disposeAll(disposables: { dispose(): void }[]): void {
  for (const d of disposables) {
    try {
      d.dispose();
    } catch (err) {
      outputChannel.appendLine(`error disposing a resource during project switch/teardown: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Everything ONE active project's pipeline consists of, standing apart from the process-lifetime
 * pieces (the output channel, the stable `sidebarProvider` instance, and every command
 * registration): the MigrationService + its CLI, file watcher, status bar, graph panel manager,
 * diagnostics, CodeLens provider, and config-change listener. `switchProject` disposes the
 * previous one of these (if any) and builds a fresh one whenever the active project changes —
 * at initial activation, and on every `alembicGraph.selectProject` switch.
 *
 * This is the "dispose and recreate" half of Task 21's in-place project switch; the other half is
 * that NOTHING outside this function needs to be recreated: commands are registered once (reading
 * `currentPipeline` fresh at call time) and the sidebar webview view provider is rebound in place
 * (`sidebarProvider.rebind`) rather than re-registered, since VS Code has no supported way to hand
 * an already-resolved WebviewView off to a second provider registration.
 */
function activateForProject(
  context: vscode.ExtensionContext,
  project: AlembicProject,
  authorProvider: AuthorProvider,
): Pipeline {
  outputChannel.appendLine(`using project: ${project.label} (${project.iniPath})`);

  const epoch = ++broadcastEpoch;
  const disposables: vscode.Disposable[] = [];

  // Everything below is wrapped so a throw PARTWAY through construction (e.g. a VS Code API call
  // failing) rolls back whatever was already pushed to `disposables` instead of leaking it —
  // without this, a mid-construction failure would leave e.g. a status bar item or file watcher
  // registered with nothing left able to dispose it, since the `dispose()` closure that would
  // normally own that job is never reached/returned. Re-thrown so `switchProject`'s own try/catch
  // handles the user-facing message and resetting `currentPipeline` to "no project".
  try {
    const cli = buildAlembicCli(project);
    // Task B1: one GhostBlameProvider per pipeline (rebuilt fresh per project, unlike the
    // extension-lifetime-shared authorProvider) — its per-id cache is scoped to THIS project's
    // versionsDir, so it never needs to reconcile ids from whatever project was active before.
    const blameProvider = createGhostBlameProvider({
      versionsDir: project.versionsDir,
      log: (line) => outputChannel.appendLine(line),
    });
    const deps = buildDeps(context, project, cli, authorProvider, blameProvider);
    const service = new MigrationService(deps);

    disposables.push(createStatusBar(service));

    // Posts to THIS pipeline's graph panel AND the stable, shared sidebar view — a no-op the
    // instant a newer pipeline has taken over (`epoch !== broadcastEpoch`), which is what stops a
    // still-in-flight action from a since-switched-away-from project from leaking its toast/busy
    // message into whatever project is active by the time it resolves (see `broadcastEpoch`'s doc
    // comment) — EXCEPT a terminal `busy:false`, which `shouldDeliverStale` always lets through
    // even from a stale epoch (see that function's doc comment for why dropping it is the actual
    // bug this guards against). `panelManagerRef` is assigned right after construction below — read
    // at CALL time (never before this function returns), so building it before `panelManager`
    // exists is fine.
    let panelManagerRef: GraphPanelManager | undefined;
    const broadcast = (msg: HostToWebviewMessage): void => {
      if (epoch !== broadcastEpoch && !shouldDeliverStale(msg)) return; // stale: a newer project is active now
      panelManagerRef?.postMessage(msg);
      sidebarProvider.postMessage(msg);
    };

    const actionCtx: ActionContext = {
      cli,
      service,
      log: (line) => outputChannel.appendLine(line),
      broadcast,
    };

    const panelManager = new GraphPanelManager(context, service, (line) => outputChannel.appendLine(line), broadcast);
    panelManagerRef = panelManager;
    disposables.push(panelManager, panelManager.registerSerializer());

    // Task 18: Problems-panel diagnostics + "Show in Migration Graph" CodeLens.
    disposables.push(createDiagnostics(service), createCodeLensProvider(service, panelManager));

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.versionsDir, "*.py"));
    watcher.onDidCreate(() => service.scheduleRefresh());
    watcher.onDidChange(() => service.scheduleRefresh());
    watcher.onDidDelete(() => service.scheduleRefresh());
    disposables.push(watcher);

    // Task 21: config live-reload. laneColorA/B, showSqlPreview, and collapseThreshold are all
    // handled by `applyConfigChange()` — a cheap re-layout-from-cache re-emit (see its doc comment
    // in migrationService.ts for why this is NOT the same as `service.refresh()`: a full refresh
    // re-reads every file from disk, resets DB/author enrichment to "unknown" for a moment, and
    // re-fires a real `alembic` subprocess plus a full git-log batch — all for a change that has
    // nothing to do with file contents). alembicCommand is already resolved fresh on every CLI
    // call (resolveAlembicCommand above) — nothing is cached to invalidate, just a log line so a
    // change is visible in the Output channel.
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("alembicGraph.laneColorA") ||
          e.affectsConfiguration("alembicGraph.laneColorB") ||
          e.affectsConfiguration("alembicGraph.showSqlPreview") ||
          e.affectsConfiguration("alembicGraph.collapseThreshold")
        ) {
          service.applyConfigChange();
        } else if (e.affectsConfiguration("alembicGraph.alembicCommand")) {
          outputChannel.appendLine("alembicGraph.alembicCommand changed — resolved fresh on the next CLI invocation");
        }
      }),
    );

    return {
      project,
      service,
      cli,
      blameProvider,
      panelManager,
      actionCtx,
      dispose() {
        disposeAll(disposables);
        try {
          service.dispose();
        } catch (err) {
          outputChannel.appendLine(`error disposing MigrationService: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Belt-and-suspenders (Task B1): this pipeline's blameProvider is about to be discarded
        // along with everything else here, but clearing its cache explicitly — rather than relying
        // solely on garbage collection — keeps its lifecycle symmetric with authorProvider's own
        // clearCache(), and guards against any future refactor that makes blameProvider outlive
        // this pipeline (e.g. hoisting it to extension-lifetime scope like authorProvider).
        blameProvider.clearCache();
      },
    };
  } catch (err) {
    disposeAll(disposables);
    throw err;
  }
}

/**
 * Tears down the previous per-project pipeline (if any) and stands up a fresh one for `project`,
 * or leaves everything torn down (and the sidebar rebound to no-project mode) if `project` is
 * null. Shared by activate()'s initial load and the `selectProject` command's in-place switch.
 *
 * Guarded end to end: if building the new pipeline (or its initial `refresh()`) throws for any
 * reason, the error is logged and surfaced as a toast rather than left to reject uncaught up
 * through a command handler (which would otherwise show a generic, unhelpful VS Code error and
 * potentially fail `activate()` itself on the initial-load path) — the extension is left cleanly
 * in "no project" state (already the reset default below) rather than some half-built pipeline.
 */
async function switchProject(
  context: vscode.ExtensionContext,
  project: AlembicProject | null,
  authorProvider: AuthorProvider,
): Promise<void> {
  if (currentPipeline) disposeAll([currentPipeline]);
  currentPipeline = undefined;

  if (project === null) {
    outputChannel.appendLine("no alembic project found");
    sidebarProvider.rebind(null, null, null);
    return;
  }

  try {
    const pipeline = activateForProject(context, project, authorProvider);
    currentPipeline = pipeline;
    sidebarProvider.rebind(pipeline.service, pipeline.panelManager, pipeline.actionCtx);
    await pipeline.service.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`error activating project ${project.label} (${project.iniPath}): ${message}`);
    void vscode.window.showErrorMessage(`Alembic Graph: failed to activate project "${project.label}" — ${message}`);
    // Leave currentPipeline/the sidebar in "no project" state rather than a half-built pipeline.
    // Whatever partial disposables `activateForProject` managed to create before throwing were
    // already rolled back by its OWN try/catch (see that function's doc comment) before this catch
    // ever runs — nothing was assigned to `currentPipeline`, so there's nothing further to tear
    // down here beyond resetting these two references.
    currentPipeline = undefined;
    sidebarProvider.rebind(null, null, null);
  }
}

/** `alembicGraph.selectProject`: re-run discovery across the whole workspace and let the user pick
 * any project, current one marked. A `null` result (0 projects found, cancelled, or the user
 * re-picked the already-active project) means "nothing to do" — see `selectProject`'s (the
 * discovery.ts one) own doc comment for exactly which of those three it was. */
async function runSelectProjectCommand(context: vscode.ExtensionContext, authorProvider: AuthorProvider): Promise<void> {
  const picked = await selectProject(context, currentPipeline?.project.iniPath ?? null);
  if (picked === null) return;
  await switchProject(context, picked, authorProvider);
}

/** Runs `action(currentPipeline)` if a project is active, otherwise shows the standard "no
 * project" info message. Consolidates the identical guard four command handlers below would
 * otherwise each repeat against `currentPipeline`. */
function withPipeline(action: (pipeline: Pipeline) => void): void {
  if (!currentPipeline) {
    void vscode.window.showInformationMessage(NO_PROJECT_MESSAGE);
    return;
  }
  action(currentPipeline);
}

/** Registers every `alembicGraph.*` command exactly once, for the life of the extension. Each
 * handler reads `currentPipeline` fresh at call time rather than closing over a value captured
 * here, which is what lets `switchProject` swap the active project without ever re-registering a
 * command. */
function registerCommands(context: vscode.ExtensionContext, authorProvider: AuthorProvider): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.refresh", () => withPipeline((p) => void p.service.refresh())),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.openGraph", () => withPipeline((p) => p.panelManager.open())),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.mergeHeads", () => withPipeline((p) => void runMergeHeadsCommand(p.actionCtx))),
  );

  // Task 16: modal-confirmed multi-head-safe upgrade-all, same as the sidebar button and graph
  // panel dispatch.
  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.upgradeHead", () => withPipeline((p) => void upgradeAction(p.actionCtx, "heads"))),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.showInGraph", (revisionId?: string) => {
      // Guards against a missing/malformed argument (e.g. invoked from the Command Palette, which
      // this command isn't designed to be run from) rather than throwing into VS Code.
      if (typeof revisionId === "string") currentPipeline?.panelManager.revealAndSelect(revisionId);
    }),
  );

  // Task 21: replaces the old stub — re-runs discovery across the whole workspace and switches
  // the active project in place.
  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.selectProject", () => runSelectProjectCommand(context, authorProvider)),
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Alembic Graph");
  context.subscriptions.push(outputChannel);
  // Deactivation tears down whatever pipeline is currently active — everything else registered in
  // this function (the sidebar provider, the commands) lives in context.subscriptions directly.
  context.subscriptions.push({
    dispose: () => {
      if (currentPipeline) disposeAll([currentPipeline]);
    },
  });

  // Shared across every project switch (Task 21): its per-path cache is keyed by absolute file
  // path, so paths from a previous project never collide with — or get evicted by — a new one.
  const authorProvider = createAuthorProvider((line) => outputChannel.appendLine(line));

  sidebarProvider = new SidebarViewProvider(context.extensionUri, null, null, (line) => outputChannel.appendLine(line), null);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebarProvider));

  registerCommands(context, authorProvider);

  const project = await pickProject(context);
  await switchProject(context, project, authorProvider);
}

export function deactivate(): void {}
