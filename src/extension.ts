import * as vscode from "vscode";
import { pickProject, type AlembicProject } from "./services/discovery";
import { MigrationService, type MigrationServiceDeps } from "./services/migrationService";
import { AlembicCli, resolveCommand } from "./services/alembicCli";
import { getActivePythonPath } from "./services/pythonEnv";
import { createStatusBar } from "./ui/statusBar";
import { GraphPanelManager } from "./ui/graphPanel";
import { SidebarViewProvider } from "./ui/sidebarView";
import { mergeHeadsAction, upgradeAction, type ActionContext } from "./ui/actions";
import type { HostToWebviewMessage, UiPrefs } from "./protocol/messages";

const SIDEBAR_VIEW_ID = "alembicGraph.sidebar";

const UI_PREFS_KEY = "alembicGraph.uiPrefs";
const DEFAULT_UI_PREFS: UiPrefs = { order: "newest-bottom", density: "comfortable", expandCollapsed: false };

let outputChannel: vscode.OutputChannel;
let currentService: MigrationService | undefined;
let currentCli: AlembicCli | undefined;

/** Minimal accessor for later tasks (status bar, graph panel, sidebar) to hook onDidChangeState. */
export function getService(): MigrationService | undefined {
  return currentService;
}

/** Accessor for later tasks (14/16/17: merge/upgrade/downgrade/revision actions) that need to run
 * alembic CLI commands beyond `current` against the active project. */
export function getCli(): AlembicCli | undefined {
  return currentCli;
}

/**
 * Resolves the alembic command to run, fresh on every call (both the override setting and the
 * active Python interpreter can change between calls — this must never be cached). Precedence:
 * a non-empty `alembicGraph.alembicCommand` override wins outright; otherwise fall back to the
 * ms-python extension's active interpreter (`python -m alembic`), then a bare `alembic` on PATH.
 */
async function resolveAlembicCommand() {
  const override = vscode.workspace.getConfiguration("alembicGraph").get<string>("alembicCommand", "");
  if (override.trim().length > 0) {
    return resolveCommand({ override, pythonPath: null });
  }
  const pythonPath = await getActivePythonPath();
  return resolveCommand({ override: "", pythonPath });
}

/** Builds the AlembicCli for `project`, rooted at its alembic.ini directory (the cwd alembic
 * itself expects to run from). */
function buildAlembicCli(project: AlembicProject): AlembicCli {
  return new AlembicCli({
    cwd: project.iniDir,
    resolve: resolveAlembicCommand,
    log: (line) => outputChannel.appendLine(line),
  });
}

function registerStubCommand(context: vscode.ExtensionContext, command: string, title: string): void {
  const disposable = vscode.commands.registerCommand(command, () => {
    vscode.window.showInformationMessage(`Alembic Graph: ${title} — not implemented yet`);
  });
  context.subscriptions.push(disposable);
}

/** Registers every not-yet-implemented command as a friendly stub. `skip` lists commands that
 * already have a real implementation wired up elsewhere in activate(). */
function registerRemainingStubs(context: vscode.ExtensionContext, skip: Set<string>): void {
  const stubs: [string, string][] = [
    ["alembicGraph.openGraph", "Open Migration Graph"],
    ["alembicGraph.refresh", "Refresh"],
    ["alembicGraph.upgradeHead", "Upgrade to Head"],
    ["alembicGraph.mergeHeads", "Merge Heads…"],
    ["alembicGraph.selectProject", "Select Alembic Project…"],
  ];
  for (const [command, title] of stubs) {
    if (skip.has(command)) continue;
    registerStubCommand(context, command, title);
  }
}

interface HeadQuickPickItem extends vscode.QuickPickItem {
  headId: string;
}

/**
 * `alembicGraph.mergeHeads` command body: needs at least 2 current heads, lets the user pick
 * exactly 2 via a multi-select QuickPick (re-prompting on any other selection count), then hands
 * off to the same `mergeHeadsAction` the graph panel's drag-and-drop uses.
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
      placeHolder: "Select exactly 2 heads to merge",
    });
    if (picked === undefined) return; // cancelled outright
    if (picked.length === 2) {
      await mergeHeadsAction(ctx, picked[0].headId, picked[1].headId);
      return;
    }
    void vscode.window.showWarningMessage(
      `Alembic Graph: select exactly 2 heads to merge (${picked.length} selected).`,
    );
    // loop: re-prompt
  }
}

/** Builds the vscode-backed MigrationServiceDeps for `project`. */
function buildDeps(context: vscode.ExtensionContext, project: AlembicProject, cli: AlembicCli): MigrationServiceDeps {
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
        laneColorA: cfg.get<string>("laneColorA", "#4aa3ff"),
        laneColorB: cfg.get<string>("laneColorB", "#c586c0"),
        showSqlPreview: cfg.get<boolean>("showSqlPreview", true),
        collapseThreshold: cfg.get<number>("collapseThreshold", 20),
      };
    },
    getUiPrefs() {
      return context.workspaceState.get<UiPrefs>(UI_PREFS_KEY, DEFAULT_UI_PREFS);
    },
    setUiPrefs(prefs) {
      void context.workspaceState.update(UI_PREFS_KEY, prefs);
    },
    log(line) {
      outputChannel.appendLine(line);
    },
    project: { label: project.label, iniPath: project.iniPath },
    async fetchCurrent() {
      const result = await cli.current();
      return result.dbReachable ? { dbReachable: true, currentIds: result.currentIds } : { dbReachable: false, currentIds: [] };
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Alembic Graph");
  context.subscriptions.push(outputChannel);

  const project = await pickProject(context);

  if (project === null) {
    outputChannel.appendLine("no alembic project found");
    const sidebarProvider = new SidebarViewProvider(
      context.extensionUri,
      null,
      null,
      (line) => outputChannel.appendLine(line),
      null, // no project -> no CLI -> no ActionContext; the sidebar's upgrade path degrades to a log line
    );
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebarProvider));
    registerRemainingStubs(context, new Set());
    return;
  }

  outputChannel.appendLine(`using project: ${project.label} (${project.iniPath})`);

  const cli = buildAlembicCli(project);
  currentCli = cli;

  const deps = buildDeps(context, project, cli);
  const service = new MigrationService(deps);
  currentService = service;
  context.subscriptions.push({
    dispose: () => {
      service.dispose();
      if (currentService === service) currentService = undefined;
      if (currentCli === cli) currentCli = undefined;
    },
  });

  context.subscriptions.push(createStatusBar(service));

  // Task 16: busy/toast messages go to BOTH webview surfaces (the graph panel's toolbar spinner /
  // drop-guard release and the sidebar's busy-disabled upgrade button), each leg a safe no-op when
  // that webview isn't open. A hoisted function declaration on purpose: its body reads
  // `panelManager`/`sidebarProvider` at CALL time (always after activate() finishes), which breaks
  // the construction cycle — the panel manager wants broadcast at construction, broadcast wants
  // the sidebar provider, and the sidebar provider wants the panel manager.
  function broadcast(msg: HostToWebviewMessage): void {
    panelManager.postMessage(msg);
    sidebarProvider.postMessage(msg);
  }

  // One shared ActionContext (Task 14, broadcast-ified in Task 16) for every command-palette
  // action and the sidebar's upgrade button. The graph panel's own CLI-backed message cases
  // (merge/upgrade/previewSql) still build an equivalent context per-message instead of reusing
  // this one, since they read `getCli()`'s freshest value rather than the one captured here at
  // activation time (see graphPanel.ts's buildActionContext).
  const actionCtx: ActionContext = {
    cli,
    service,
    log: (line) => outputChannel.appendLine(line),
    broadcast,
  };

  const panelManager = new GraphPanelManager(context, service, (line) => outputChannel.appendLine(line), broadcast);
  context.subscriptions.push(panelManager);
  context.subscriptions.push(panelManager.registerSerializer());

  const sidebarProvider = new SidebarViewProvider(
    context.extensionUri,
    service,
    panelManager,
    (line) => outputChannel.appendLine(line),
    actionCtx,
  );
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebarProvider));

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.versionsDir, "*.py"));
  watcher.onDidCreate(() => service.scheduleRefresh());
  watcher.onDidChange(() => service.scheduleRefresh());
  watcher.onDidDelete(() => service.scheduleRefresh());
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.refresh", () => service.refresh()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.openGraph", () => panelManager.open()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.mergeHeads", () => runMergeHeadsCommand(actionCtx)),
  );
  // Task 16: real implementation replacing the stub — same modal-confirmed multi-head-safe
  // upgrade-all the sidebar button and graph panel dispatch.
  context.subscriptions.push(
    vscode.commands.registerCommand("alembicGraph.upgradeHead", () => upgradeAction(actionCtx, "heads")),
  );

  registerRemainingStubs(
    context,
    new Set(["alembicGraph.refresh", "alembicGraph.openGraph", "alembicGraph.mergeHeads", "alembicGraph.upgradeHead"]),
  );

  await service.refresh();
}

export function deactivate(): void {}
