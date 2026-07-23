import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import type { WorktreeContext } from "./worktree";

export interface AlembicCommand {
  argv0: string;
  prefixArgs: string[];
}

/**
 * Searches the supplied project/workspace bases for `.venv` or `venv`, preferring a direct
 * Alembic entry point and accepting a Python fallback only when the Alembic package is present.
 */
export function findProjectEnvCommand(opts: {
  iniDir: string;
  workspaceRoot: string | null;
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
  listDir?: (candidate: string) => string[];
}): AlembicCommand | null {
  const platform = opts.platform ?? process.platform;
  const rawExists = opts.exists ?? existsSync;
  const exists = (candidate: string): boolean => {
    try {
      return rawExists(candidate);
    } catch {
      return false;
    }
  };
  const rawListDir = opts.listDir ?? ((candidate: string) => readdirSync(candidate));
  const listDir = (candidate: string): string[] => {
    try {
      return rawListDir(candidate);
    } catch {
      return [];
    }
  };

  const hasAlembicPackage = (envRoot: string): boolean => {
    if (platform === "win32") return exists(path.join(envRoot, "Lib", "site-packages", "alembic"));
    return listDir(path.join(envRoot, "lib"))
      .filter((name) => name.startsWith("python"))
      .some((name) => exists(path.join(envRoot, "lib", name, "site-packages", "alembic")));
  };

  const bases = opts.workspaceRoot !== null && opts.workspaceRoot !== opts.iniDir
    ? [opts.iniDir, opts.workspaceRoot]
    : [opts.iniDir];
  const binDirName = platform === "win32" ? "Scripts" : "bin";
  const suffix = platform === "win32" ? ".exe" : "";

  for (const base of bases) {
    for (const envDir of [".venv", "venv"]) {
      const envRoot = path.join(base, envDir);
      const binDir = path.join(envRoot, binDirName);
      const alembicPath = path.join(binDir, `alembic${suffix}`);
      if (exists(alembicPath)) return { argv0: alembicPath, prefixArgs: [] };

      const pythonPath = path.join(binDir, `python${suffix}`);
      if (exists(pythonPath) && hasAlembicPackage(envRoot)) {
        return { argv0: pythonPath, prefixArgs: ["-m", "alembic"] };
      }
    }
  }
  return null;
}

/** Legacy pure command resolver retained for callers/tests while runtime resolution moves here. */
export function resolveCommand(opts: {
  override: string;
  pythonPath: string | null;
  iniDir?: string;
  workspaceRoot?: string | null;
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
}): AlembicCommand {
  const override = opts.override.trim();
  if (override.length > 0) {
    const [argv0, ...prefixArgs] = override.split(/\s+/);
    return { argv0, prefixArgs };
  }
  if (opts.pythonPath !== null) return { argv0: opts.pythonPath, prefixArgs: ["-m", "alembic"] };
  if (opts.iniDir !== undefined) {
    const discovered = findProjectEnvCommand({
      iniDir: opts.iniDir,
      workspaceRoot: opts.workspaceRoot ?? null,
      platform: opts.platform,
      exists: opts.exists,
    });
    if (discovered !== null) return discovered;
  }
  return { argv0: "alembic", prefixArgs: [] };
}

export interface RuntimeSettings {
  alembicCommand: string;
  environmentFile: string;
  pythonEnvironmentPath: string;
}

export type RuntimeCommandSource =
  | "override"
  | "configured-python"
  | "ms-python"
  | "project-venv"
  | "workspace-venv"
  | "main-project-venv"
  | "main-worktree-venv"
  | "path";

export interface ResolvedAlembicRuntime {
  command: AlembicCommand;
  env: NodeJS.ProcessEnv;
  commandSource: RuntimeCommandSource;
  environmentFile: string | null;
}

export interface RuntimePathContext {
  iniDir: string;
  workspaceFolder: string | null;
  homeDir: string;
  worktree: WorktreeContext | null;
}

const TOKEN_RE = /\$\{([^}]+)\}/;

/** Expands the path forms supported by the worktree-aware runtime settings. */
export function expandRuntimePath(raw: string, context: RuntimePathContext): string {
  let expanded = raw.trim();
  const replacements: [string, string | null][] = [
    ["workspaceFolder", context.workspaceFolder],
    ["gitMainWorktree", context.worktree?.mainRoot ?? null],
    ["gitMainProject", context.worktree?.mainProjectDir ?? null],
  ];

  for (const [token, value] of replacements) {
    const marker = `\${${token}}`;
    if (!expanded.includes(marker)) continue;
    if (value === null) throw new Error(`path token \${${token}} is unavailable for this project`);
    expanded = expanded.split(marker).join(value);
  }

  const unsupported = TOKEN_RE.exec(expanded);
  if (unsupported !== null) throw new Error(`unsupported path token \${${unsupported[1]}}`);

  if (expanded === "~") {
    expanded = context.homeDir;
  } else if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(context.homeDir, expanded.slice(2));
  }

  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(context.iniDir, expanded));
}

/** Resolves a user-selected virtualenv directory or exact Python executable. */
export function findPythonEnvironmentCommand(
  configuredPath: string,
  opts: {
    platform?: NodeJS.Platform;
    exists?: (candidate: string) => boolean;
    stat?: (candidate: string) => { isDirectory(): boolean; isFile(): boolean };
  } = {},
): AlembicCommand {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const stat = opts.stat ?? statSync;

  if (!exists(configuredPath)) {
    throw new Error(`configured Python environment "${configuredPath}" does not exist`);
  }

  let info: { isDirectory(): boolean; isFile(): boolean };
  try {
    info = stat(configuredPath);
  } catch (err) {
    throw new Error(
      `configured Python environment "${configuredPath}" cannot be inspected: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (info.isFile()) return { argv0: configuredPath, prefixArgs: ["-m", "alembic"] };
  if (!info.isDirectory()) {
    throw new Error(`configured Python environment "${configuredPath}" is not a file or directory`);
  }

  const binDir = path.join(configuredPath, platform === "win32" ? "Scripts" : "bin");
  const suffix = platform === "win32" ? ".exe" : "";
  const alembicPath = path.join(binDir, `alembic${suffix}`);
  if (exists(alembicPath)) return { argv0: alembicPath, prefixArgs: [] };

  const pythonPath = path.join(binDir, `python${suffix}`);
  if (exists(pythonPath)) return { argv0: pythonPath, prefixArgs: ["-m", "alembic"] };

  throw new Error(
    `configured Python environment "${configuredPath}" does not contain ${path.join(
      platform === "win32" ? "Scripts" : "bin",
      `alembic${suffix}`,
    )} or ${path.join(platform === "win32" ? "Scripts" : "bin", `python${suffix}`)}`,
  );
}

function parseOverride(override: string): AlembicCommand {
  return resolveCommand({ override, pythonPath: null });
}

function discoveredEnvAt(base: string): AlembicCommand | null {
  return findProjectEnvCommand({
    iniDir: base,
    workspaceRoot: null,
    exists: existsSync,
    listDir: readdirSync,
  });
}

export interface ProjectRuntimeResolver {
  resolve(): Promise<ResolvedAlembicRuntime>;
}

/** Builds a per-project runtime resolver. Settings and env files are read fresh for every run. */
export function createProjectRuntimeResolver(opts: {
  iniDir: string;
  workspaceFolder: string | null;
  getSettings: () => RuntimeSettings;
  getActivePythonPath: () => Promise<string | null>;
  getWorktreeContext: () => Promise<WorktreeContext | null>;
  log: (line: string) => void;
  homeDir?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): ProjectRuntimeResolver {
  let cachedWorktree: WorktreeContext | undefined;
  let worktreeInFlight: Promise<WorktreeContext | null> | undefined;
  let loggedWorktree = false;

  const getWorktree = (): Promise<WorktreeContext | null> => {
    if (cachedWorktree !== undefined) return Promise.resolve(cachedWorktree);
    if (worktreeInFlight === undefined) {
      worktreeInFlight = opts.getWorktreeContext().then((context) => {
        if (context === null) {
          opts.log("runtime: Git worktree context unavailable");
        } else {
          cachedWorktree = context;
          if (!loggedWorktree) {
            loggedWorktree = true;
            opts.log(
              `runtime: ${context.linked ? "linked" : "main"} worktree current=${context.currentRoot} main=${
                context.mainRoot ?? "unavailable"
              }`,
            );
          }
        }
        return context;
      }).finally(() => {
        worktreeInFlight = undefined;
      });
    }
    return worktreeInFlight;
  };

  const pathContext = (worktree: WorktreeContext | null): RuntimePathContext => ({
    iniDir: opts.iniDir,
    workspaceFolder: opts.workspaceFolder,
    homeDir: opts.homeDir ?? os.homedir(),
    worktree,
  });

  const loadEnvironment = (
    rawPath: string,
    worktree: WorktreeContext | null,
  ): { env: NodeJS.ProcessEnv; environmentFile: string | null } => {
    const baseEnv = opts.baseEnv ?? process.env;
    if (rawPath.trim().length === 0) return { env: { ...baseEnv }, environmentFile: null };

    const environmentFile = expandRuntimePath(rawPath, pathContext(worktree));
    let text: string;
    try {
      text = readFileSync(environmentFile, "utf8");
    } catch (err) {
      throw new Error(
        `configured environment file "${environmentFile}" could not be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const fileEnv = parseDotenv(text);
    opts.log(`runtime: environment file=${environmentFile} (process environment takes precedence)`);
    return { env: { ...fileEnv, ...baseEnv }, environmentFile };
  };

  const findRuntimeCommand = async (
    settings: RuntimeSettings,
    worktree: WorktreeContext | null,
  ): Promise<{ command: AlembicCommand; commandSource: RuntimeCommandSource }> => {
    if (settings.alembicCommand.trim().length > 0) {
      return { command: parseOverride(settings.alembicCommand), commandSource: "override" };
    }

    if (settings.pythonEnvironmentPath.trim().length > 0) {
      const configuredPath = expandRuntimePath(settings.pythonEnvironmentPath, pathContext(worktree));
      return {
        command: findPythonEnvironmentCommand(configuredPath),
        commandSource: "configured-python",
      };
    }

    const activePython = await opts.getActivePythonPath();
    if (activePython !== null) {
      return {
        command: { argv0: activePython, prefixArgs: ["-m", "alembic"] },
        commandSource: "ms-python",
      };
    }

    const candidates: { base: string; source: RuntimeCommandSource }[] = [
      { base: opts.iniDir, source: "project-venv" },
    ];
    if (opts.workspaceFolder !== null && path.resolve(opts.workspaceFolder) !== path.resolve(opts.iniDir)) {
      candidates.push({ base: opts.workspaceFolder, source: "workspace-venv" });
    }
    if (worktree?.linked === true) {
      if (worktree.mainProjectDir !== null) {
        candidates.push({ base: worktree.mainProjectDir, source: "main-project-venv" });
      }
      if (worktree.mainRoot !== null) {
        candidates.push({ base: worktree.mainRoot, source: "main-worktree-venv" });
      }
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      const normalized = path.resolve(candidate.base);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const command = discoveredEnvAt(normalized);
      if (command !== null) return { command, commandSource: candidate.source };
    }

    return { command: { argv0: "alembic", prefixArgs: [] }, commandSource: "path" };
  };

  return {
    async resolve(): Promise<ResolvedAlembicRuntime> {
      const settings = opts.getSettings();
      const worktree = await getWorktree();
      const { env, environmentFile } = loadEnvironment(settings.environmentFile, worktree);
      const { command, commandSource } = await findRuntimeCommand(settings, worktree);
      opts.log(`runtime: command source=${commandSource}`);
      return { command, env, commandSource, environmentFile };
    },
  };
}
