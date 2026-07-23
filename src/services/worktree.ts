import { execFile } from "node:child_process";
import path from "node:path";

export interface WorktreeContext {
  currentRoot: string;
  mainRoot: string | null;
  mainProjectDir: string | null;
  linked: boolean;
}

export interface WorktreeRecord {
  path: string;
  bare: boolean;
}

export interface WorktreeExecResult {
  ok: boolean;
  stdout: string;
  error: string;
}

export type WorktreeExecFn = (
  argv0: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<WorktreeExecResult>;

const TIMEOUT_MS = 5000;

function defaultExec(
  argv0: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<WorktreeExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(argv0, args, { cwd: opts.cwd, timeout: opts.timeoutMs }, (err, stdout) => {
        if (err !== null) {
          resolve({ ok: false, stdout: "", error: err.message });
          return;
        }
        resolve({ ok: true, stdout, error: "" });
      });
    } catch (err) {
      resolve({ ok: false, stdout: "", error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Parses `git worktree list --porcelain`, preserving Git's record order. */
export function parseWorktreeList(stdout: string): WorktreeRecord[] {
  const worktrees: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current !== null) worktrees.push(current);
      const worktreePath = line.slice("worktree ".length);
      current = worktreePath.length > 0
        ? { path: path.normalize(worktreePath), bare: false }
        : null;
    } else if (line === "bare" && current !== null) {
      current.bare = true;
    }
  }
  if (current !== null) worktrees.push(current);
  return worktrees;
}

function correspondingProjectDir(currentRoot: string, mainRoot: string, projectDir: string): string | null {
  const relative = path.relative(currentRoot, projectDir);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return path.resolve(mainRoot, relative);
}

/** Resolves linked-worktree metadata from Git. Any failure is logged and returned as null. */
export async function resolveWorktreeContext(opts: {
  cwd: string;
  projectDir: string;
  log: (line: string) => void;
  exec?: WorktreeExecFn;
}): Promise<WorktreeContext | null> {
  const exec = opts.exec ?? defaultExec;

  const run = async (args: string[]): Promise<string | null> => {
    let result: WorktreeExecResult;
    try {
      result = await exec("git", args, { cwd: opts.cwd, timeoutMs: TIMEOUT_MS });
    } catch (err) {
      opts.log(`worktree: git ${args.join(" ")} threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (!result.ok) {
      opts.log(`worktree: git ${args.join(" ")} failed: ${result.error}`);
      return null;
    }
    return result.stdout;
  };

  const currentStdout = await run(["rev-parse", "--show-toplevel"]);
  if (currentStdout === null || currentStdout.trim().length === 0) return null;
  const currentRoot = path.normalize(currentStdout.trim());

  const listStdout = await run(["worktree", "list", "--porcelain"]);
  if (listStdout === null) return null;
  const worktrees = parseWorktreeList(listStdout);
  if (worktrees.length === 0) {
    opts.log("worktree: git worktree list returned no worktree records");
    return null;
  }
  if (!worktrees.some((candidate) => path.resolve(candidate.path) === path.resolve(currentRoot))) {
    opts.log(`worktree: git worktree list did not include the current checkout ${currentRoot}`);
    return null;
  }

  const primary = worktrees[0];
  const mainRoot = primary.bare ? null : primary.path;
  return {
    currentRoot,
    mainRoot,
    mainProjectDir: mainRoot === null
      ? null
      : correspondingProjectDir(currentRoot, mainRoot, path.resolve(opts.projectDir)),
    linked: mainRoot === null || currentRoot !== mainRoot,
  };
}
