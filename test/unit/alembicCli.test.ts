import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { existsSync, rmSync, mkdtempSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  AlembicCli,
  parseCurrentOutput,
  resolveCommand,
  findProjectEnvCommand,
  type ExecFn,
  type RunResult,
} from "../../src/services/alembicCli";
import { parseRevisionSource } from "../../src/core/parser";
import { computeRepointedSource } from "../../src/core/repoint";
import { cliErrorText } from "../../src/ui/actionHelpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../..");
const VENV_PYTHON = path.join(REPO_ROOT, ".venv/bin/python");
const HEALTHY_PROJECT = path.join(REPO_ROOT, "fixtures/healthy-project");
const BROKEN_PROJECT = path.join(REPO_ROOT, "fixtures/broken-project");

/** Builds an AlembicCli that runs `node <script/args>` directly (no alembic involved) via the
 * REAL default exec — `resolve` returns process.execPath so run(args) becomes `node args...`. */
function makeNodeCli(opts: { timeoutMs?: number; log?: (line: string) => void } = {}): AlembicCli {
  return new AlembicCli({
    cwd: REPO_ROOT,
    resolve: async () => ({ argv0: process.execPath, prefixArgs: [] }),
    log: opts.log ?? (() => {}),
    timeoutMs: opts.timeoutMs,
  });
}

describe("resolveCommand", () => {
  it("1a. non-empty override is whitespace-split into argv0 + prefix args", () => {
    expect(resolveCommand({ override: "poetry run alembic", pythonPath: null })).toEqual({
      argv0: "poetry",
      prefixArgs: ["run", "alembic"],
    });
    // override wins even when a pythonPath is also known
    expect(resolveCommand({ override: "poetry run alembic", pythonPath: "/usr/bin/python3" })).toEqual({
      argv0: "poetry",
      prefixArgs: ["run", "alembic"],
    });
  });

  it("1b. pythonPath (no override) -> python -m alembic", () => {
    expect(resolveCommand({ override: "", pythonPath: "/venv/bin/python" })).toEqual({
      argv0: "/venv/bin/python",
      prefixArgs: ["-m", "alembic"],
    });
    // whitespace-only override does not count as an override
    expect(resolveCommand({ override: "   ", pythonPath: "/venv/bin/python" })).toEqual({
      argv0: "/venv/bin/python",
      prefixArgs: ["-m", "alembic"],
    });
  });

  it("1c. neither -> bare alembic on PATH", () => {
    expect(resolveCommand({ override: "", pythonPath: null })).toEqual({ argv0: "alembic", prefixArgs: [] });
  });
});

describe("findProjectEnvCommand", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDir(...segments: string[]): string {
    const p = path.join(tmpDir, ...segments);
    mkdirSync(p, { recursive: true });
    return p;
  }

  it("8a. venv alembic binary found at iniDir -> direct alembic form", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-findenv-"));
    const iniDir = makeDir("proj");
    const binDir = makeDir("proj", ".venv", "bin");
    writeFileSync(path.join(binDir, "alembic"), "");

    expect(findProjectEnvCommand({ iniDir, workspaceRoot: null })).toEqual({
      argv0: path.join(binDir, "alembic"),
      prefixArgs: [],
    });
  });

  it("8b. python-only venv -> -m alembic form", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-findenv-"));
    const iniDir = makeDir("proj");
    const binDir = makeDir("proj", ".venv", "bin");
    writeFileSync(path.join(binDir, "python"), "");

    expect(findProjectEnvCommand({ iniDir, workspaceRoot: null })).toEqual({
      argv0: path.join(binDir, "python"),
      prefixArgs: ["-m", "alembic"],
    });
  });

  it("8c. iniDir env beats workspaceRoot env", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-findenv-"));
    const iniDir = makeDir("proj");
    const workspaceRoot = makeDir("workspace");
    writeFileSync(path.join(makeDir("proj", ".venv", "bin"), "alembic"), "");
    writeFileSync(path.join(makeDir("workspace", ".venv", "bin"), "alembic"), "");

    expect(findProjectEnvCommand({ iniDir, workspaceRoot })).toEqual({
      argv0: path.join(iniDir, ".venv", "bin", "alembic"),
      prefixArgs: [],
    });
  });

  it("8d. .venv beats venv within the same base", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-findenv-"));
    const iniDir = makeDir("proj");
    writeFileSync(path.join(makeDir("proj", ".venv", "bin"), "alembic"), "");
    writeFileSync(path.join(makeDir("proj", "venv", "bin"), "alembic"), "");

    expect(findProjectEnvCommand({ iniDir, workspaceRoot: null })).toEqual({
      argv0: path.join(iniDir, ".venv", "bin", "alembic"),
      prefixArgs: [],
    });
  });

  it("8e. nothing found (no .venv/venv at all) -> null", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-findenv-"));
    const iniDir = makeDir("proj");

    expect(findProjectEnvCommand({ iniDir, workspaceRoot: null })).toBeNull();
  });

  it("8f. workspaceRoot venv used when iniDir has none", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-findenv-"));
    const iniDir = makeDir("proj");
    const workspaceRoot = makeDir("workspace");
    writeFileSync(path.join(makeDir("workspace", ".venv", "bin"), "python"), "");

    expect(findProjectEnvCommand({ iniDir, workspaceRoot })).toEqual({
      argv0: path.join(workspaceRoot, ".venv", "bin", "python"),
      prefixArgs: ["-m", "alembic"],
    });
  });

  it("8g. win32 branch (injected platform + exists): Scripts/alembic.exe found", () => {
    const iniDir = "C:\\proj";
    const alembicExe = path.join(iniDir, ".venv", "Scripts", "alembic.exe");
    const exists = (p: string) => p === alembicExe;

    expect(findProjectEnvCommand({ iniDir, workspaceRoot: null, platform: "win32", exists })).toEqual({
      argv0: alembicExe,
      prefixArgs: [],
    });
  });

  it("8h. win32 branch (injected platform + exists): Scripts/python.exe found when no alembic.exe", () => {
    const iniDir = "C:\\proj";
    const pythonExe = path.join(iniDir, ".venv", "Scripts", "python.exe");
    const exists = (p: string) => p === pythonExe;

    expect(findProjectEnvCommand({ iniDir, workspaceRoot: null, platform: "win32", exists })).toEqual({
      argv0: pythonExe,
      prefixArgs: ["-m", "alembic"],
    });
  });

  it("8i. never throws even if exists() throws", () => {
    const exists = () => {
      throw new Error("boom");
    };
    expect(() => findProjectEnvCommand({ iniDir: "/nope", workspaceRoot: null, exists: exists as unknown as (p: string) => boolean })).not.toThrow();
  });
});

describe("resolveCommand + project venv discovery precedence", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDir(...segments: string[]): string {
    const p = path.join(tmpDir, ...segments);
    mkdirSync(p, { recursive: true });
    return p;
  }

  it("9a. ms-python pythonPath still wins over a discoverable project venv", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-resolveenv-"));
    const iniDir = makeDir("proj");
    writeFileSync(path.join(makeDir("proj", ".venv", "bin"), "alembic"), "");

    expect(resolveCommand({ override: "", pythonPath: "/venv/bin/python", iniDir, workspaceRoot: null })).toEqual({
      argv0: "/venv/bin/python",
      prefixArgs: ["-m", "alembic"],
    });
  });

  it("9b. pythonPath null + discoverable venv -> venv command", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-resolveenv-"));
    const iniDir = makeDir("proj");
    const binDir = makeDir("proj", ".venv", "bin");
    writeFileSync(path.join(binDir, "alembic"), "");

    expect(resolveCommand({ override: "", pythonPath: null, iniDir, workspaceRoot: null })).toEqual({
      argv0: path.join(binDir, "alembic"),
      prefixArgs: [],
    });
  });

  it("9c. override still wins outright even with a discoverable venv", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-resolveenv-"));
    const iniDir = makeDir("proj");
    writeFileSync(path.join(makeDir("proj", ".venv", "bin"), "alembic"), "");

    expect(resolveCommand({ override: "poetry run alembic", pythonPath: null, iniDir, workspaceRoot: null })).toEqual({
      argv0: "poetry",
      prefixArgs: ["run", "alembic"],
    });
  });

  it("9d. no pythonPath, no discoverable venv -> falls through to bare alembic on PATH", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-resolveenv-"));
    const iniDir = makeDir("proj"); // no .venv/venv underneath

    expect(resolveCommand({ override: "", pythonPath: null, iniDir, workspaceRoot: null })).toEqual({
      argv0: "alembic",
      prefixArgs: [],
    });
  });

  it("9e. omitting iniDir entirely preserves the original (pre-discovery) behavior", () => {
    expect(resolveCommand({ override: "", pythonPath: null })).toEqual({ argv0: "alembic", prefixArgs: [] });
  });
});

describe("parseCurrentOutput", () => {
  it("2a. two head lines -> both ids", () => {
    expect(parseCurrentOutput("3aebf1885b7d (head)\n4bfc02996c8e (head)\n")).toEqual([
      "3aebf1885b7d",
      "4bfc02996c8e",
    ]);
  });

  it("2b. empty string -> []", () => {
    expect(parseCurrentOutput("")).toEqual([]);
  });

  it("2c. noise lines (INFO logs, blanks, non-hex text) are ignored", () => {
    const stdout = [
      "INFO  [alembic.runtime.migration] Context impl SQLiteImpl.",
      "",
      "INFO  [alembic.runtime.migration] Will assume non-transactional DDL.",
      "3aebf1885b7d (head)",
      "  ", // whitespace-only
      "not-a-revision line",
    ].join("\n");
    expect(parseCurrentOutput(stdout)).toEqual(["3aebf1885b7d"]);
  });

  it("2d. uppercase hex accepted; bare id (no suffix) accepted", () => {
    expect(parseCurrentOutput("3AEBF1885B7D (head)\n4bfc02996c8e\n")).toEqual(["3AEBF1885B7D", "4bfc02996c8e"]);
  });
});

describe("AlembicCli.run (real default exec, node -e scripts)", () => {
  it("3a. success captures stdout", async () => {
    const cli = makeNodeCli();
    const result = await cli.run(["-e", "process.stdout.write('hello from child')"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stdout).toBe("hello from child");
  });

  it("3b. non-zero exit -> ok:false with stderr captured", async () => {
    const cli = makeNodeCli();
    const result = await cli.run(["-e", "process.stderr.write('boom-stderr'); process.exit(3)"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).toContain("boom-stderr");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("3c. timeout kills the child, resolves promptly with an error mentioning the timeout", async () => {
    const cli = makeNodeCli({ timeoutMs: 200 });
    const started = Date.now();
    const result = await cli.run(["-e", "setTimeout(() => {}, 2000)"]); // would run 2s
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1500); // resolved promptly, not after the child's 2s
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out after 200ms");
  });

  it("3d. a missing binary resolves ok:false (never throws/rejects), rewritten to an actionable message", async () => {
    const cli = new AlembicCli({
      cwd: REPO_ROOT,
      resolve: async () => ({ argv0: "this-binary-does-not-exist-xyz", prefixArgs: [] }),
      log: () => {},
    });
    const result = await cli.run(["current"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("alembic not found");
      expect(result.error).toContain('tried "this-binary-does-not-exist-xyz"');
    }
  });

  it("4. mutex: two concurrent run() calls serialize (second starts after first ends) in FIFO order", async () => {
    const cli = makeNodeCli();
    // Each child prints its start and end timestamps (ms) around a 150ms busy period.
    const script = (tag: string) =>
      `process.stdout.write('start:' + Date.now() + ';'); setTimeout(() => process.stdout.write('end:' + Date.now() + ';tag:${tag}'), 150)`;

    const [first, second] = await Promise.all([cli.run(["-e", script("A")]), cli.run(["-e", script("B")])]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const parse = (out: string) => ({
      start: Number(/start:(\d+)/.exec(out)![1]),
      end: Number(/end:(\d+)/.exec(out)![1]),
      tag: /tag:(\w+)/.exec(out)![1],
    });
    const a = parse((first as { ok: true; stdout: string }).stdout);
    const b = parse((second as { ok: true; stdout: string }).stdout);

    expect(a.tag).toBe("A"); // FIFO: first call's promise carries the first child's output
    expect(b.tag).toBe("B");
    expect(b.start).toBeGreaterThanOrEqual(a.end); // serialized: B's child started after A's ended
  });

  it("logs the command line before running and the exit info after", async () => {
    const log = vi.fn();
    const cli = makeNodeCli({ log });
    await cli.run(["-e", "process.exit(0)"]);
    expect(log).toHaveBeenCalledWith(`$ ${process.execPath} -e process.exit(0) (${REPO_ROOT})`);
    expect(log).toHaveBeenCalledWith("  exit 0");
  });

  it("a rejecting resolve() degrades to ok:false without spawning anything", async () => {
    const log = vi.fn();
    const cli = new AlembicCli({
      cwd: REPO_ROOT,
      resolve: async () => {
        throw new Error("interpreter discovery exploded");
      },
      log,
    });
    const result = await cli.run(["current"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("interpreter discovery exploded");
  });
});

describe("AlembicCli.current (injected exec)", () => {
  function makeCli(execResult: RunResult): { cli: AlembicCli; exec: ReturnType<typeof vi.fn> } {
    const exec = vi.fn<ExecFn>(async () => execResult);
    const cli = new AlembicCli({
      cwd: "/proj",
      resolve: async () => ({ argv0: "alembic", prefixArgs: [] }),
      log: () => {},
      exec,
    });
    return { cli, exec };
  }

  it("5a. ok stdout is parsed into dbReachable:true + currentIds", async () => {
    const { cli, exec } = makeCli({
      ok: true,
      stdout: "INFO  [alembic.runtime.migration] Context impl SQLiteImpl.\n3aebf1885b7d (head)\n",
      stderr: "",
    });
    await expect(cli.current()).resolves.toEqual({ dbReachable: true, currentIds: ["3aebf1885b7d"] });
    expect(exec).toHaveBeenCalledWith("alembic", ["current"], { cwd: "/proj", timeoutMs: 30000 });
  });

  it("5b. ok:false -> dbReachable:false (no currentIds leak through)", async () => {
    const { cli } = makeCli({ ok: false, error: "db is down", stdout: "3aebf1885b7d (head)\n", stderr: "" });
    await expect(cli.current()).resolves.toEqual({ dbReachable: false });
  });
});

describe("AlembicCli.run ENOENT rewrite (actionable message)", () => {
  it("10a. a spawn ENOENT error is rewritten to name the resolved argv0 and hint at the fixes", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ ok: false, error: "spawn alembic ENOENT", stdout: "", stderr: "" }));
    const cli = new AlembicCli({
      cwd: "/proj",
      resolve: async () => ({ argv0: "alembic", prefixArgs: [] }),
      log: () => {},
      exec,
    });

    const result = await cli.run(["current"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("alembic not found");
      expect(result.error).toContain('tried "alembic"');
      expect(result.error).toContain("alembicGraph.alembicCommand");
      expect(result.error).toContain("ms-python");
    }
  });

  it("10b. the original spawn error line is still logged to the output channel before the rewrite", async () => {
    const log = vi.fn();
    const exec = vi.fn<ExecFn>(async () => ({
      ok: false,
      error: "spawn /venv/bin/alembic ENOENT",
      stdout: "",
      stderr: "",
    }));
    const cli = new AlembicCli({
      cwd: "/proj",
      resolve: async () => ({ argv0: "/venv/bin/alembic", prefixArgs: [] }),
      log,
      exec,
    });

    const result = await cli.run(["current"]);
    expect(log).toHaveBeenCalledWith("  spawn /venv/bin/alembic ENOENT");
    if (!result.ok) expect(result.error).toContain('tried "/venv/bin/alembic"');
  });

  it("10c. non-ENOENT errors pass through unchanged", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ ok: false, error: "db is down", stdout: "", stderr: "" }));
    const cli = new AlembicCli({
      cwd: "/proj",
      resolve: async () => ({ argv0: "alembic", prefixArgs: [] }),
      log: () => {},
      exec,
    });

    const result = await cli.run(["current"]);
    if (!result.ok) expect(result.error).toBe("db is down");
  });
});

describe.skipIf(!existsSync(VENV_PYTHON))("AlembicCli real-fixture integration (.venv alembic)", () => {
  afterAll(() => {
    // `alembic current` auto-creates a fresh sqlite fixture.db in each fixture's cwd — never leave
    // those behind for other tests / the F5 fixtures.
    rmSync(path.join(HEALTHY_PROJECT, "fixture.db"), { force: true });
    rmSync(path.join(BROKEN_PROJECT, "fixture.db"), { force: true });
  });

  function makeFixtureCli(cwd: string): AlembicCli {
    return new AlembicCli({
      cwd,
      resolve: async () => ({ argv0: VENV_PYTHON, prefixArgs: ["-m", "alembic"] }),
      log: () => {},
    });
  }

  it("6a. healthy fixture: run(['heads']) stdout contains both head ids", async () => {
    const cli = makeFixtureCli(HEALTHY_PROJECT);
    const result = await cli.run(["heads"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).toContain("3aebf1885b7d");
      expect(result.stdout).toContain("4bfc02996c8e");
    }
  }, 30000);

  it("6b. healthy fixture: current() -> dbReachable true with [] (fresh sqlite, nothing applied)", async () => {
    const cli = makeFixtureCli(HEALTHY_PROJECT);
    await expect(cli.current()).resolves.toEqual({ dbReachable: true, currentIds: [] });
  }, 30000);

  it("6c. broken fixture: current() -> dbReachable false (alembic crashes on the broken chain)", async () => {
    const cli = makeFixtureCli(BROKEN_PROJECT);
    await expect(cli.current()).resolves.toEqual({ dbReachable: false });
  }, 30000);

  describe("6d. merge integration (Task 14 — real alembic, tmp copy)", () => {
    // Golden rule for this test: NEVER run `merge` (or any other mutating command) against
    // HEALTHY_PROJECT/BROKEN_PROJECT directly — those are checked-in fixtures other tests and F5
    // depend on. Copy to os.tmpdir() first, mutate the copy, and always clean it up below.
    let tmpDir: string | undefined;

    afterAll(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("6d. merge -m against a tmp copy: new versions file down-revises both heads; heads collapses to one", async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-merge-"));
      const projectDir = path.join(tmpDir, "healthy-project");
      cpSync(HEALTHY_PROJECT, projectDir, { recursive: true });

      const cli = makeFixtureCli(projectDir);
      const versionsDir = path.join(projectDir, "alembic/versions");
      const before = new Set(readdirSync(versionsDir).filter((f) => f.endsWith(".py")));

      const result = await cli.run(["merge", "-m", "test merge", "3aebf1885b7d", "4bfc02996c8e"]);
      expect(result.ok).toBe(true);

      const after = readdirSync(versionsDir).filter((f) => f.endsWith(".py"));
      const newFiles = after.filter((f) => !before.has(f));
      expect(newFiles).toHaveLength(1);

      // Use the REAL parser (not a hand-rolled regex here) to confirm the new file's
      // down_revision tuple names exactly the two merged heads, order-independent.
      const newFilePath = path.join(versionsDir, newFiles[0]);
      const parsed = parseRevisionSource(readFileSync(newFilePath, "utf-8"), newFilePath);
      expect(parsed).not.toBeNull();
      expect(new Set(parsed?.downRevisions)).toEqual(new Set(["3aebf1885b7d", "4bfc02996c8e"]));

      const headsResult = await cli.run(["heads"]);
      expect(headsResult.ok).toBe(true);
      if (headsResult.ok) {
        const headLines = headsResult.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        expect(headLines).toHaveLength(1); // both original heads merged into a single new head
      }
    }, 30000);
  });

  /** Recursively deletes every `__pycache__` dir under `dir`. Python's default bytecode-cache
   * invalidation stores the source file's mtime with WHOLE-SECOND resolution — copying a fixture
   * (whose versions/*.py already ship a checked-in __pycache__/*.pyc, see fixtures/broken-project)
   * and then running `alembic heads` (which compiles + caches a fresh .pyc for whatever content is
   * on disk at that instant) followed by an in-process rewrite of the SAME file within the same
   * wall-clock second can leave a stale .pyc whose recorded mtime happens to match the rewritten
   * file's — Python then silently reuses the STALE (pre-repoint) bytecode instead of re-parsing
   * the new source, so `alembic` keeps seeing the broken `down_revision` even though the file on
   * disk is already fixed. Called right after rewriting the repointed file, before the CLI is
   * asked to read it again, so there is no bytecode cache left to possibly collide with.
   */
  function removePycacheDirs(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "__pycache__") {
        rmSync(entryPath, { recursive: true, force: true });
      } else {
        removePycacheDirs(entryPath);
      }
    }
  }

  describe("6e. repoint repair integration (Task 15 — real alembic, tmp copy)", () => {
    // Same golden rule as 6d: never mutate BROKEN_PROJECT directly — copy first, always clean up.
    let tmpDir: string | undefined;

    afterAll(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("6e. computeRepointedSource repairs the broken chain: `alembic heads` goes from crashing to listing exactly 2 real heads", async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-repoint-"));
      const projectDir = path.join(tmpDir, "broken-project");
      cpSync(BROKEN_PROJECT, projectDir, { recursive: true });

      const cli = makeFixtureCli(projectDir);

      // Sanity check: the broken chain really does crash `alembic heads` before the repair (same
      // proof 6c gives for current(), here for the command repointAction's toast text refers to).
      const before = await cli.run(["heads"]);
      expect(before.ok).toBe(false);

      const brokenFilePath = path.join(projectDir, "alembic/versions/5c0d13aa7d9f_add_audit_log.py");
      const src = readFileSync(brokenFilePath, "utf-8");
      const result = computeRepointedSource(src, "deadbeef0000", "4bfc02996c8e");
      expect(result.ok).toBe(true);
      if (result.ok) writeFileSync(brokenFilePath, result.newSrc);
      removePycacheDirs(projectDir); // see removePycacheDirs's doc comment — avoids a same-second stale .pyc

      // Use the REAL parser (not a hand-rolled regex) to confirm the on-disk file now down-revises
      // the real target — same cross-check style 6d uses for its own new file.
      const parsed = parseRevisionSource(readFileSync(brokenFilePath, "utf-8"), brokenFilePath);
      expect(parsed?.downRevisions).toEqual(["4bfc02996c8e"]);

      const after = await cli.run(["heads"]);
      expect(after.ok).toBe(true);
      if (after.ok) {
        const headIds = after.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((l) => l.split(/\s+/)[0]);
        // 4bfc02996c8e is no longer a head (5c0d13aa7d9f now revises it); 5c0d13aa7d9f is.
        expect(new Set(headIds)).toEqual(new Set(["3aebf1885b7d", "5c0d13aa7d9f"]));
        expect(headIds).toHaveLength(2);
      }
    }, 30000);
  });

  describe("6f. upgrade integration (Task 16 — real alembic, tmp copy)", () => {
    // Same golden rule as 6d/6e: `upgrade heads` writes a real sqlite fixture.db — never run it
    // against HEALTHY_PROJECT directly. Copy to os.tmpdir() first, mutate the copy, clean up.
    let tmpDir: string | undefined;

    afterAll(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("6f. upgrade heads against a tmp copy: ok, and current() then reports BOTH head ids applied", async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-upgrade-"));
      const projectDir = path.join(tmpDir, "healthy-project");
      cpSync(HEALTHY_PROJECT, projectDir, { recursive: true });

      const cli = makeFixtureCli(projectDir);

      // Plural `heads` (what every Task 16 call site passes): with 2 heads, singular `head`
      // errors out — this is the multi-head-safe upgrade-all.
      const result = await cli.run(["upgrade", "heads"]);
      expect(result.ok).toBe(true);

      // The DB now exists and BOTH branches' heads are current — the same current() round trip
      // upgradeAction's follow-up service.refresh() enrichment performs. Order isn't guaranteed
      // by alembic, hence the Set comparison.
      const current = await cli.current();
      expect(current.dbReachable).toBe(true);
      if (current.dbReachable) {
        expect(new Set(current.currentIds)).toEqual(new Set(["3aebf1885b7d", "4bfc02996c8e"]));
        expect(current.currentIds).toHaveLength(2);
      }
    }, 30000);
  });

  describe("7a. downgrade integration (Task 17 — real alembic, tmp copy)", () => {
    // Same golden rule as 6d–6f: `upgrade`/`downgrade` write a real sqlite fixture.db — never run
    // them against HEALTHY_PROJECT directly. Copy to os.tmpdir() first, mutate the copy, clean up.
    let tmpDir: string | undefined;

    afterAll(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("7a. upgrade heads then downgrade 8f2a1c9d4e07: ok, and current() = exactly the downgrade target", async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-downgrade-"));
      const projectDir = path.join(tmpDir, "healthy-project");
      cpSync(HEALTHY_PROJECT, projectDir, { recursive: true });

      const cli = makeFixtureCli(projectDir);

      // Apply everything first (same as 6f) so there's real DB state to walk back down from.
      const up = await cli.run(["upgrade", "heads"]);
      expect(up.ok).toBe(true);

      // The exact call downgradeToAction makes: `alembic downgrade <full id>`. 8f2a1c9d4e07 is
      // the fixture's single root, so after downgrading to it BOTH branches' revisions are
      // unapplied and it is the one and only current revision — no Set/order caveat needed.
      const down = await cli.run(["downgrade", "8f2a1c9d4e07"]);
      expect(down.ok).toBe(true);

      const current = await cli.current();
      expect(current).toEqual({ dbReachable: true, currentIds: ["8f2a1c9d4e07"] });
    }, 30000);
  });

  describe("7b. new-revision integration (Task 17 — real alembic, tmp copy)", () => {
    // Same golden rule as 6d–6g: `revision -m` writes a new versions/*.py file — never run it
    // against HEALTHY_PROJECT directly. Copy to os.tmpdir() first, mutate the copy, clean up.
    let tmpDir: string | undefined;

    afterAll(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("7b. revision -m against a tmp copy: multi-head refusal is readable; after a merge it succeeds and the new file parses with the right message", async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-revision-"));
      const projectDir = path.join(tmpDir, "healthy-project");
      cpSync(HEALTHY_PROJECT, projectDir, { recursive: true });

      const cli = makeFixtureCli(projectDir);
      const versionsDir = path.join(projectDir, "alembic/versions");

      // Deviation from the Task 17 brief (noted in the task report): on a MULTI-head project,
      // bare `alembic revision -m <msg>` — the exact args newRevisionAction runs — REFUSES to
      // guess a parent and exits non-zero ("Multiple heads are present..."), so the brief's
      // "run(['revision','-m',...]) ok" can't happen on this 2-head fixture as-is, and no head
      // count ever "grows by 1" (a new revision replaces its parent as head; only `--head=base`,
      // which newRevisionAction never passes, would add one). Assert the refusal is READABLE
      // first — this is a NORMAL failure mode the action's error toast must surface legibly, same
      // as autogenerate-without-a-db. Alembic prints this particular refusal on STDOUT with
      // stderr completely empty, which is exactly why cliErrorText grew its stdout-FAILED-line
      // fallback (see src/ui/actionHelpers.ts) — assert the actual toast text end to end.
      const refused = await cli.run(["revision", "-m", "test revision"]);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.stdout).toContain("Multiple heads are present");
        expect(cliErrorText(refused)).toMatch(/^FAILED: Multiple heads are present/);
      }

      // Collapse to a single head (the same real `merge` 6d exercises), then run the action's
      // exact args again — the success path a single-head project (the common case) would hit
      // directly.
      const merged = await cli.run(["merge", "-m", "collapse heads for revision test", "3aebf1885b7d", "4bfc02996c8e"]);
      expect(merged.ok).toBe(true);
      const afterMerge = new Set(readdirSync(versionsDir).filter((f) => f.endsWith(".py")));

      const result = await cli.run(["revision", "-m", "test revision"]);
      expect(result.ok).toBe(true);

      // A new versions file exists and the REAL parser reads back the message we passed.
      const newFiles = readdirSync(versionsDir).filter((f) => f.endsWith(".py") && !afterMerge.has(f));
      expect(newFiles).toHaveLength(1);
      const newFilePath = path.join(versionsDir, newFiles[0]);
      const parsed = parseRevisionSource(readFileSync(newFilePath, "utf-8"), newFilePath);
      expect(parsed).not.toBeNull();
      expect(parsed?.message).toBe("test revision");

      // The new revision took over as the single head (its parent — the merge revision — no
      // longer is one).
      const heads = await cli.run(["heads"]);
      expect(heads.ok).toBe(true);
      if (heads.ok) {
        const headIds = heads.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((l) => l.split(/\s+/)[0]);
        expect(headIds).toEqual([parsed?.revision]);
      }
    }, 30000);
  });

  describe("6g. offline SQL preview integration (Task 16 — real alembic, FRESH tmp copy)", () => {
    // A fresh copy, separate from 6f's (which really upgrades its DB): the whole point here is
    // proving `--sql` NEVER touches a database — an already-created fixture.db would make that
    // proof meaningless.
    let tmpDir: string | undefined;

    afterAll(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("6g. upgrade heads --sql: ok, stdout is the DDL (CREATE TABLE), and NO sqlite db file is created (offline proof)", async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-sqlpreview-"));
      const projectDir = path.join(tmpDir, "healthy-project");
      cpSync(HEALTHY_PROJECT, projectDir, { recursive: true });

      // alembic.ini: sqlite:///fixture.db (cwd-relative). The checked-in fixture never SHIPS one
      // (gitignored), but earlier tests in this suite (6a/6b's `current()`) auto-create it there
      // and only the suite-level afterAll deletes it — so a mid-suite copy can inherit it. Scrub
      // it from the copy so the absence assertion below actually proves --sql created nothing.
      const dbPath = path.join(projectDir, "fixture.db");
      rmSync(dbPath, { force: true });
      expect(existsSync(dbPath)).toBe(false);

      const cli = makeFixtureCli(projectDir);
      const result = await cli.run(["upgrade", "heads", "--sql"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The SQL script lands on stdout (alembic's INFO chatter goes to stderr) — this is
        // exactly what previewSqlAction opens in the untitled sql editor.
        expect(result.stdout).toContain("CREATE TABLE");
        expect(result.stdout).toContain("alembic_version");
      }

      // Offline proof: sqlite auto-creates its file on ANY real connection (6b relies on that),
      // so the file still being absent means --sql never opened one.
      expect(existsSync(dbPath)).toBe(false);
    }, 30000);
  });

  describe("6h. findProjectEnvCommand real integration (repo's own .venv)", () => {
    // fixtures/healthy-project has no .venv/venv of its own, so this proves the workspaceRoot tier
    // (the repo root, whose real .venv has alembic installed) is what discovery falls back to —
    // and that the discovered command actually runs `alembic heads` successfully end to end.
    it("6h. discovers a working alembic command against the repo root and runs heads successfully", async () => {
      const found = findProjectEnvCommand({ iniDir: HEALTHY_PROJECT, workspaceRoot: REPO_ROOT });
      expect(found).not.toBeNull();
      expect(found?.argv0.startsWith(path.join(REPO_ROOT, ".venv"))).toBe(true);

      const cli = new AlembicCli({ cwd: HEALTHY_PROJECT, resolve: async () => found!, log: () => {} });
      const result = await cli.run(["heads"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.stdout).toContain("3aebf1885b7d");
        expect(result.stdout).toContain("4bfc02996c8e");
      }
    }, 30000);
  });
});
