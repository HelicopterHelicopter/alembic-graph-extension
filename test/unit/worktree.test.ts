import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  parseWorktreeList,
  resolveWorktreeContext,
  type WorktreeExecFn,
} from "../../src/services/worktree";

describe("parseWorktreeList", () => {
  it("returns worktree records in porcelain order, including paths with spaces", () => {
    expect(
      parseWorktreeList(
        [
          "worktree /repos/main checkout",
          "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "branch refs/heads/main",
          "",
          "worktree /repos/feature",
          "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "branch refs/heads/feature",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "/repos/main checkout", bare: false },
      { path: "/repos/feature", bare: false },
    ]);
  });

  it("returns an empty list for malformed or empty porcelain output", () => {
    expect(parseWorktreeList("HEAD abc\nbranch refs/heads/main\n")).toEqual([]);
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("resolveWorktreeContext", () => {
  function execFor(currentRoot: string, porcelain: string): WorktreeExecFn {
    return vi.fn(async (_argv0, args) => {
      if (args[0] === "rev-parse") return { ok: true, stdout: `${currentRoot}\n`, error: "" };
      return { ok: true, stdout: porcelain, error: "" };
    });
  }

  it("identifies a normal checkout as its own main worktree", async () => {
    const root = path.join(path.sep, "repo");
    const projectDir = path.join(root, "services", "api");
    const exec = execFor(root, `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n`);

    await expect(resolveWorktreeContext({ cwd: projectDir, projectDir, exec, log: vi.fn() })).resolves.toEqual({
      currentRoot: root,
      mainRoot: root,
      mainProjectDir: projectDir,
      linked: false,
    });
  });

  it("maps a monorepo project from a linked worktree into the main checkout", async () => {
    const mainRoot = path.join(path.sep, "repo");
    const currentRoot = path.join(path.sep, "worktrees", "feature");
    const projectDir = path.join(currentRoot, "services", "api");
    const exec = execFor(
      currentRoot,
      [
        `worktree ${mainRoot}`,
        "HEAD abc",
        "branch refs/heads/main",
        "",
        `worktree ${currentRoot}`,
        "HEAD def",
        "branch refs/heads/feature",
        "",
      ].join("\n"),
    );

    await expect(resolveWorktreeContext({ cwd: projectDir, projectDir, exec, log: vi.fn() })).resolves.toEqual({
      currentRoot,
      mainRoot,
      mainProjectDir: path.join(mainRoot, "services", "api"),
      linked: true,
    });
  });

  it("leaves the main checkout unavailable when the repository is bare", async () => {
    const bareRoot = path.join(path.sep, "repos", "project.git");
    const currentRoot = path.join(path.sep, "worktrees", "feature");
    const projectDir = path.join(currentRoot, "services", "api");
    const exec = execFor(
      currentRoot,
      [
        `worktree ${bareRoot}`,
        "bare",
        "",
        `worktree ${currentRoot}`,
        "HEAD def",
        "branch refs/heads/feature",
        "",
      ].join("\n"),
    );

    await expect(resolveWorktreeContext({ cwd: projectDir, projectDir, exec, log: vi.fn() })).resolves.toEqual({
      currentRoot,
      mainRoot: null,
      mainProjectDir: null,
      linked: true,
    });
  });

  it("returns null and logs safely when Git is unavailable", async () => {
    const log = vi.fn();
    const exec = vi.fn<WorktreeExecFn>(async () => ({
      ok: false,
      stdout: "",
      error: "spawn git ENOENT",
    }));

    await expect(
      resolveWorktreeContext({ cwd: "/repo/project", projectDir: "/repo/project", exec, log }),
    ).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("spawn git ENOENT"));
  });

  it("returns null when worktree porcelain output is malformed", async () => {
    const log = vi.fn();
    const exec = execFor("/repo", "HEAD abc\nbranch refs/heads/main\n");

    await expect(resolveWorktreeContext({ cwd: "/repo", projectDir: "/repo", exec, log })).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no worktree records"));
  });

  it("returns null when Git does not list the current checkout", async () => {
    const log = vi.fn();
    const exec = execFor("/worktrees/feature", "worktree /repo\nHEAD abc\nbranch refs/heads/main\n");

    await expect(
      resolveWorktreeContext({
        cwd: "/worktrees/feature/project",
        projectDir: "/worktrees/feature/project",
        exec,
        log,
      }),
    ).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("current checkout"));
  });

  it("leaves mainProjectDir unavailable when the project is outside the Git root", async () => {
    const mainRoot = path.join(path.sep, "repo");
    const currentRoot = path.join(path.sep, "worktree");
    const projectDir = path.join(path.sep, "external", "api");
    const exec = execFor(
      currentRoot,
      `worktree ${mainRoot}\nHEAD abc\n\nworktree ${currentRoot}\nHEAD def\n`,
    );

    await expect(resolveWorktreeContext({ cwd: projectDir, projectDir, exec, log: vi.fn() })).resolves.toEqual({
      currentRoot,
      mainRoot,
      mainProjectDir: null,
      linked: true,
    });
  });
});
