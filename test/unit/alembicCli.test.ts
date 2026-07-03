import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, rmSync, mkdtempSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  AlembicCli,
  parseCurrentOutput,
  resolveCommand,
  type ExecFn,
  type RunResult,
} from "../../src/services/alembicCli";
import { parseRevisionSource } from "../../src/core/parser";

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

  it("3d. a missing binary resolves ok:false (never throws/rejects)", async () => {
    const cli = new AlembicCli({
      cwd: REPO_ROOT,
      resolve: async () => ({ argv0: "this-binary-does-not-exist-xyz", prefixArgs: [] }),
      log: () => {},
    });
    const result = await cli.run(["current"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ENOENT");
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
});
