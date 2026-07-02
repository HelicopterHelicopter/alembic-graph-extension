/**
 * Workspace-level Alembic project discovery. This is the ONLY layer (besides extension.ts)
 * allowed to import `vscode` — the pure ini scan lives in core/ini.ts, and MigrationService
 * consumes the resolved AlembicProject purely through injected deps.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { parseScriptLocation } from "../core/ini";

export interface AlembicProject {
  iniPath: string;
  iniDir: string;
  scriptDir: string;
  versionsDir: string;
  label: string;
}

const SELECTED_INI_KEY = "alembicGraph.selectedIni";

/** Finds every alembic.ini in the workspace whose resolved script_location has a versions dir. */
export async function discoverProjects(): Promise<AlembicProject[]> {
  const iniUris = await vscode.workspace.findFiles("**/alembic.ini", "**/{node_modules,.venv,venv,.git}/**");

  const projects: AlembicProject[] = [];
  for (const iniUri of iniUris) {
    const project = await tryResolveProject(iniUri);
    if (project !== null) projects.push(project);
  }

  projects.sort((a, b) => a.label.localeCompare(b.label));
  return projects;
}

async function tryResolveProject(iniUri: vscode.Uri): Promise<AlembicProject | null> {
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(iniUri);
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }

  const scriptLocationRaw = parseScriptLocation(text);
  if (scriptLocationRaw === null) return null;

  const iniPath = iniUri.fsPath;
  const iniDir = path.dirname(iniPath);
  const substituted = scriptLocationRaw.replace(/%\(here\)s/g, iniDir);
  const scriptDir = path.isAbsolute(substituted) ? path.normalize(substituted) : path.resolve(iniDir, substituted);
  const versionsDir = path.join(scriptDir, "versions");

  const versionsDirExists = await isDirectory(versionsDir);
  if (!versionsDirExists) return null;

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(iniUri);
  const workspaceFolderName = workspaceFolder?.name ?? path.basename(path.dirname(iniDir));
  const label = `${workspaceFolderName} / ${path.basename(scriptDir)}`;

  return { iniPath, iniDir, scriptDir, versionsDir, label };
}

async function isDirectory(fsPath: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

/**
 * Resolves which project to use: none found -> null; exactly one -> it, no prompt; more than
 * one -> the previously persisted selection if it's still among the discovered projects,
 * otherwise a QuickPick (persisting the choice for next time). A user-facing re-pick command
 * arrives in Task 21; `SELECTED_INI_KEY` is the workspaceState key it will reuse.
 */
export async function pickProject(context: vscode.ExtensionContext): Promise<AlembicProject | null> {
  const projects = await discoverProjects();
  if (projects.length === 0) return null;
  if (projects.length === 1) return projects[0];

  const persistedIniPath = context.workspaceState.get<string>(SELECTED_INI_KEY);
  if (persistedIniPath !== undefined) {
    const stillValid = projects.find((p) => p.iniPath === persistedIniPath);
    if (stillValid !== undefined) return stillValid;
  }

  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.label, detail: p.iniPath, project: p })),
    { placeHolder: "Select an Alembic project" },
  );
  if (picked === undefined) return null;

  await context.workspaceState.update(SELECTED_INI_KEY, picked.project.iniPath);
  return picked.project;
}
