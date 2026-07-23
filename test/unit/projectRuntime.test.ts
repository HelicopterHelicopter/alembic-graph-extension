import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProjectRuntimeResolver,
  expandRuntimePath,
  findPythonEnvironmentCommand,
  type RuntimeSettings,
} from "../../src/services/projectRuntime";
import type { WorktreeContext } from "../../src/services/worktree";

describe("expandRuntimePath", () => {
  const context = {
    iniDir: "/linked/services/api",
    workspaceFolder: "/linked",
    homeDir: "/home/dev",
    worktree: {
      currentRoot: "/linked",
      mainRoot: "/main checkout",
      mainProjectDir: "/main checkout/services/api",
      linked: true,
    } satisfies WorktreeContext,
  };

  it("resolves relative paths against the Alembic ini directory", () => {
    expect(expandRuntimePath("../shared/.env", context)).toBe("/linked/services/shared/.env");
  });

  it("expands home, workspace, and Git worktree tokens without breaking spaces", () => {
    expect(expandRuntimePath("~/envs/api", context)).toBe("/home/dev/envs/api");
    expect(expandRuntimePath("${workspaceFolder}/.venv", context)).toBe("/linked/.venv");
    expect(expandRuntimePath("${gitMainWorktree}/shared env", context)).toBe("/main checkout/shared env");
    expect(expandRuntimePath("${gitMainProject}/.env", context)).toBe("/main checkout/services/api/.env");
  });

  it("rejects unavailable and unknown tokens instead of treating them as literal paths", () => {
    expect(() =>
      expandRuntimePath("${gitMainProject}/.env", { ...context, worktree: null }),
    ).toThrow("gitMainProject");
    expect(() => expandRuntimePath("${env:HOME}/.env", context)).toThrow("unsupported path token");
  });
});

describe("findPythonEnvironmentCommand", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir.length > 0) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  it("accepts an exact Python executable", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-runtime-python-"));
    const python = path.join(tmpDir, "python with spaces");
    writeFileSync(python, "");

    expect(findPythonEnvironmentCommand(python)).toEqual({
      argv0: python,
      prefixArgs: ["-m", "alembic"],
    });
  });

  it("prefers a direct Alembic executable in an explicitly configured environment directory", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-runtime-venv-"));
    const bin = path.join(tmpDir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "python"), "");
    writeFileSync(path.join(bin, "alembic"), "");

    expect(findPythonEnvironmentCommand(tmpDir)).toEqual({
      argv0: path.join(bin, "alembic"),
      prefixArgs: [],
    });
  });

  it("supports Windows virtualenv layout through the injected platform", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-runtime-winvenv-"));
    const scripts = path.join(tmpDir, "Scripts");
    mkdirSync(scripts);
    writeFileSync(path.join(scripts, "python.exe"), "");

    expect(findPythonEnvironmentCommand(tmpDir, { platform: "win32" })).toEqual({
      argv0: path.join(scripts, "python.exe"),
      prefixArgs: ["-m", "alembic"],
    });
  });

  it("rejects missing or unusable explicitly configured paths", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-runtime-invalid-"));
    expect(() => findPythonEnvironmentCommand(path.join(tmpDir, "missing"))).toThrow("does not exist");
    expect(() => findPythonEnvironmentCommand(tmpDir)).toThrow("does not contain");
  });
});

describe("createProjectRuntimeResolver", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir.length > 0) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  function makeDir(...parts: string[]): string {
    const result = path.join(tmpDir, ...parts);
    mkdirSync(result, { recursive: true });
    return result;
  }

  function addVenv(base: string, name = ".venv"): string {
    const bin = path.join(base, name, "bin");
    mkdirSync(bin, { recursive: true });
    const alembic = path.join(bin, "alembic");
    writeFileSync(alembic, "");
    return alembic;
  }

  function settings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
    return {
      alembicCommand: "",
      environmentFile: "",
      pythonEnvironmentPath: "",
      ...overrides,
    };
  }

  function setup(overrides: {
    runtimeSettings?: RuntimeSettings;
    activePython?: string | null;
    worktree?: WorktreeContext | null;
    baseEnv?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    log?: ReturnType<typeof vi.fn>;
  } = {}) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-project-runtime-"));
    const currentRoot = makeDir("linked");
    const iniDir = makeDir("linked", "services", "api");
    const workspaceFolder = currentRoot;
    const mainRoot = makeDir("main checkout");
    const mainProjectDir = makeDir("main checkout", "services", "api");
    const worktree = overrides.worktree === undefined
      ? { currentRoot, mainRoot, mainProjectDir, linked: true }
      : overrides.worktree;
    const log = overrides.log ?? vi.fn();
    const resolver = createProjectRuntimeResolver({
      iniDir,
      workspaceFolder,
      homeDir: makeDir("home"),
      getSettings: () => overrides.runtimeSettings ?? settings(),
      getActivePythonPath: async () => overrides.activePython ?? null,
      getWorktreeContext: async () => worktree,
      baseEnv: overrides.baseEnv ?? {},
      platform: overrides.platform,
      log,
    });
    return { resolver, currentRoot, iniDir, workspaceFolder, mainRoot, mainProjectDir, log };
  }

  it("uses command override first while still loading the configured environment file", async () => {
    const log = vi.fn();
    const state = setup({
      runtimeSettings: settings({
        alembicCommand: "poetry run alembic",
        environmentFile: "${gitMainProject}/.env",
        pythonEnvironmentPath: "${gitMainWorktree}/custom-env",
      }),
      activePython: "/selected/python",
      baseEnv: { SHARED: "from-process" },
      log,
    });
    writeFileSync(
      path.join(state.mainProjectDir, ".env"),
      "DATABASE_URL=sqlite:///main.db\nSHARED=from-file\nSECRET_VALUE=do-not-log\n",
    );

    const runtime = await state.resolver.resolve();
    expect(runtime.command).toEqual({ argv0: "poetry", prefixArgs: ["run", "alembic"] });
    expect(runtime.commandSource).toBe("override");
    expect(runtime.environmentFile).toBe(path.join(state.mainProjectDir, ".env"));
    expect(runtime.env).toMatchObject({
      DATABASE_URL: "sqlite:///main.db",
      SHARED: "from-process",
      SECRET_VALUE: "do-not-log",
    });
    expect(log.mock.calls.flat().join("\n")).not.toContain("do-not-log");
  });

  it("preserves process values across case-insensitive environment collisions on Windows", async () => {
    const state = setup({
      runtimeSettings: settings({ environmentFile: "${gitMainProject}/.env" }),
      baseEnv: {
        Path: "from-process",
        Database_Url: "process-db",
      },
      platform: "win32",
    });
    writeFileSync(
      path.join(state.mainProjectDir, ".env"),
      "PATH=from-file\nDATABASE_URL=file-db\nFILE_ONLY=file-only\n",
    );

    expect((await state.resolver.resolve()).env).toEqual({
      Path: "from-process",
      Database_Url: "process-db",
      FILE_ONLY: "file-only",
    });
  });

  it("uses configured Python before the project-scoped ms-python interpreter", async () => {
    const state = setup({
      runtimeSettings: settings({ pythonEnvironmentPath: "${gitMainWorktree}/configured env" }),
      activePython: "/selected/python",
    });
    const configured = path.join(state.mainRoot, "configured env");
    const configuredBin = path.join(configured, "bin");
    mkdirSync(configuredBin, { recursive: true });
    writeFileSync(path.join(configuredBin, "python"), "");

    await expect(state.resolver.resolve()).resolves.toMatchObject({
      command: { argv0: path.join(configuredBin, "python"), prefixArgs: ["-m", "alembic"] },
      commandSource: "configured-python",
    });
  });

  it("uses project-scoped ms-python before any discovered virtualenv", async () => {
    const state = setup({ activePython: "/selected/python" });
    addVenv(state.iniDir);

    await expect(state.resolver.resolve()).resolves.toMatchObject({
      command: { argv0: "/selected/python", prefixArgs: ["-m", "alembic"] },
      commandSource: "ms-python",
    });
  });

  it("prefers current project and workspace virtualenvs over main-worktree fallbacks", async () => {
    const state = setup();
    const currentProject = addVenv(state.iniDir);
    addVenv(state.workspaceFolder, "venv");
    addVenv(state.mainProjectDir);
    addVenv(state.mainRoot);

    await expect(state.resolver.resolve()).resolves.toMatchObject({
      command: { argv0: currentProject, prefixArgs: [] },
      commandSource: "project-venv",
    });
  });

  it("falls back through current workspace, main project, then main root virtualenvs", async () => {
    const state = setup();
    const workspaceAlembic = addVenv(state.workspaceFolder);
    const mainProjectAlembic = addVenv(state.mainProjectDir);
    const mainRootAlembic = addVenv(state.mainRoot);

    await expect(state.resolver.resolve()).resolves.toMatchObject({
      command: { argv0: workspaceAlembic },
      commandSource: "workspace-venv",
    });
    rmSync(path.join(state.workspaceFolder, ".venv"), { recursive: true, force: true });
    await expect(state.resolver.resolve()).resolves.toMatchObject({
      command: { argv0: mainProjectAlembic },
      commandSource: "main-project-venv",
    });
    rmSync(path.join(state.mainProjectDir, ".venv"), { recursive: true, force: true });
    await expect(state.resolver.resolve()).resolves.toMatchObject({
      command: { argv0: mainRootAlembic },
      commandSource: "main-worktree-venv",
    });
  });

  it("does not search the main checkout when the current checkout is not linked", async () => {
    const state = setup();
    addVenv(state.mainProjectDir);
    const normalContext: WorktreeContext = {
      currentRoot: state.currentRoot,
      mainRoot: state.currentRoot,
      mainProjectDir: state.iniDir,
      linked: false,
    };
    const resolver = createProjectRuntimeResolver({
      iniDir: state.iniDir,
      workspaceFolder: state.workspaceFolder,
      homeDir: tmpDir,
      getSettings: () => settings(),
      getActivePythonPath: async () => null,
      getWorktreeContext: async () => normalContext,
      baseEnv: {},
      log: vi.fn(),
    });

    await expect(resolver.resolve()).resolves.toMatchObject({
      command: { argv0: "alembic", prefixArgs: [] },
      commandSource: "path",
    });
  });

  it("retries worktree discovery after a transient failure", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-project-runtime-retry-"));
    const currentRoot = makeDir("linked");
    const iniDir = makeDir("linked", "services", "api");
    const mainRoot = makeDir("main");
    const mainProjectDir = makeDir("main", "services", "api");
    const mainAlembic = addVenv(mainProjectDir);
    const context: WorktreeContext = {
      currentRoot,
      mainRoot,
      mainProjectDir,
      linked: true,
    };
    let attempts = 0;
    const resolver = createProjectRuntimeResolver({
      iniDir,
      workspaceFolder: currentRoot,
      getSettings: () => settings(),
      getActivePythonPath: async () => null,
      getWorktreeContext: async () => {
        attempts += 1;
        return attempts === 1 ? null : context;
      },
      baseEnv: {},
      log: vi.fn(),
    });

    await expect(resolver.resolve()).resolves.toMatchObject({
      command: { argv0: "alembic", prefixArgs: [] },
      commandSource: "path",
    });
    await expect(resolver.resolve()).resolves.toMatchObject({
      command: { argv0: mainAlembic, prefixArgs: [] },
      commandSource: "main-project-venv",
    });
    expect(attempts).toBe(2);
  });

  it("fails closed for missing environment files and invalid configured Python paths", async () => {
    const missingEnv = setup({
      runtimeSettings: settings({ environmentFile: "${gitMainProject}/missing.env" }),
    });
    await expect(missingEnv.resolver.resolve()).rejects.toThrow("environment file");

    const invalidPython = setup({
      runtimeSettings: settings({ pythonEnvironmentPath: "${gitMainWorktree}/missing-venv" }),
    });
    await expect(invalidPython.resolver.resolve()).rejects.toThrow("Python environment");
  });

  it("reads the environment file fresh on every resolution", async () => {
    const state = setup({
      runtimeSettings: settings({ environmentFile: "${gitMainProject}/.env" }),
    });
    const envPath = path.join(state.mainProjectDir, ".env");
    writeFileSync(envPath, "VALUE=first\n");
    expect((await state.resolver.resolve()).env.VALUE).toBe("first");

    writeFileSync(envPath, "VALUE=second\n");
    expect((await state.resolver.resolve()).env.VALUE).toBe("second");
  });
});
