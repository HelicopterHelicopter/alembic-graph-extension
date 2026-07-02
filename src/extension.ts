import * as vscode from "vscode";
import { pickProject, type AlembicProject } from "./services/discovery";
import { MigrationService, type MigrationServiceDeps } from "./services/migrationService";
import { createStatusBar } from "./ui/statusBar";
import { GraphPanelManager } from "./ui/graphPanel";
import type { UiPrefs } from "./protocol/messages";

const UI_PREFS_KEY = "alembicGraph.uiPrefs";
const DEFAULT_UI_PREFS: UiPrefs = { order: "newest-bottom", density: "comfortable", expandCollapsed: false };

let outputChannel: vscode.OutputChannel;
let currentService: MigrationService | undefined;

/** Minimal accessor for later tasks (status bar, graph panel, sidebar) to hook onDidChangeState. */
export function getService(): MigrationService | undefined {
  return currentService;
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

/** Builds the vscode-backed MigrationServiceDeps for `project`. */
function buildDeps(context: vscode.ExtensionContext, project: AlembicProject): MigrationServiceDeps {
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
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Alembic Graph");
  context.subscriptions.push(outputChannel);

  const project = await pickProject(context);

  if (project === null) {
    outputChannel.appendLine("no alembic project found");
    registerRemainingStubs(context, new Set());
    return;
  }

  outputChannel.appendLine(`using project: ${project.label} (${project.iniPath})`);

  const deps = buildDeps(context, project);
  const service = new MigrationService(deps);
  currentService = service;
  context.subscriptions.push({
    dispose: () => {
      service.dispose();
      if (currentService === service) currentService = undefined;
    },
  });

  context.subscriptions.push(createStatusBar(service));

  const panelManager = new GraphPanelManager(context, service, (line) => outputChannel.appendLine(line));
  context.subscriptions.push(panelManager);
  context.subscriptions.push(panelManager.registerSerializer());

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

  registerRemainingStubs(context, new Set(["alembicGraph.refresh", "alembicGraph.openGraph"]));

  await service.refresh();
}

export function deactivate(): void {}
