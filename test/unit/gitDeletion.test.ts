import { describe, it, expect, vi, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createGhostBlameProvider, type ExecFn, type ExecResult } from "../../src/services/gitDeletion";
import { parseRevisionSource } from "../../src/core/parser";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../..");
const HEALTHY_VERSIONS = path.join(REPO_ROOT, "fixtures/healthy-project/alembic/versions");

const VERSIONS_DIR = "/proj/alembic/versions";

/** Builds a NUL-delimited `git log ... --name-status` style stdout blob for N synthetic commits,
 * newest-first — mirrors exactly what real git emits for `--format=%H%x00%an%x00%aI%x00%s
 * --name-status`: each record's formatted fields are NUL-separated, then a blank line, then one
 * `STATUS\tpath` line per changed file, and the NEXT record's `%H` is glued on with NO separator
 * (verified against real git in a scratch repo while designing this test). */
function nameStatusStdout(records: { commit: string; author: string; date: string; subject: string; lines: string[] }[]): string {
  return records
    .map((r) => `${r.commit}\0${r.author}\0${r.date}\0${r.subject}\n\n${r.lines.join("\n")}\n`)
    .join("");
}

/** Builds the single-record `git log -1 --format=%H%x00%an%x00%aI%x00%s%x00%B` stdout blob. */
function introStdout(commit: string, author: string, date: string, subject: string, body: string): string {
  return `${commit}\0${author}\0${date}\0${subject}\0${body}`;
}

function ok(stdout: string): ExecResult {
  return { ok: true, stdout, stderr: "" };
}
function fail(error = "git: not a git repository"): ExecResult {
  return { ok: false, error, stdout: "", stderr: error };
}

describe("createGhostBlameProvider (injected fake exec)", () => {
  it("1a. pickaxe hit verified via pre-image -> kind:deleted-here with all fields, shortCommit = first 8", async () => {
    const commit = "abc123def456abc123def456abc123def456abc";
    const preimage = "revision = 'deadbeef0000'\ndown_revision = None\n";
    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      if (args[0] === "log" && args.some((a) => a.startsWith("-Sdeadbeef0000")) && args.includes("--diff-filter=D")) {
        return ok(
          nameStatusStdout([
            {
              commit,
              author: "Ada Lovelace",
              date: "2026-01-02T00:00:00Z",
              subject: "delete old revision",
              lines: [`D\t${VERSIONS_DIR}/deadbeef0000_old.py`],
            },
          ]),
        );
      }
      if (args[0] === "show" && args[1] === `${commit}^:${VERSIONS_DIR}/deadbeef0000_old.py`) {
        return ok(preimage);
      }
      return ok(""); // rev-parse / anything else: harmless empty
    });

    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    const result = await provider.lookup([{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }]);

    expect(result["deadbeef0000"]).toEqual({
      kind: "deleted-here",
      commit,
      shortCommit: commit.slice(0, 8),
      author: "Ada Lovelace",
      date: "2026-01-02T00:00:00Z",
      subject: "delete old revision",
      deletedFilePath: `${VERSIONS_DIR}/deadbeef0000_old.py`,
    });
  });

  it("1b. verification REJECT: pre-image parses to a different revision id (a deleted referencer) -> falls through to null", async () => {
    const commit = "def456abc123def456abc123def456abc123def4";
    // The deleted file's content actually defines a DIFFERENT revision (it only referenced
    // deadbeef0000 as its down_revision) -> must be rejected, not accepted as deleted-here.
    const preimage = "revision = 'notdeadbeef1'\ndown_revision = 'deadbeef0000'\n";
    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      if (args[0] === "log" && args.some((a) => a.startsWith("-Sdeadbeef0000"))) {
        return ok(
          nameStatusStdout([
            {
              commit,
              author: "Someone",
              date: "2026-01-02T00:00:00Z",
              subject: "delete referencer",
              lines: [`D\t${VERSIONS_DIR}/notdeadbeef1_referencer.py`],
            },
          ]),
        );
      }
      if (args[0] === "show" && args[1] === `${commit}^:${VERSIONS_DIR}/notdeadbeef1_referencer.py`) {
        return ok(preimage);
      }
      return ok(""); // glob fallback, --all fallback, intro blame, rev-parse: all empty -> null overall
    });

    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    const result = await provider.lookup([{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }]);

    expect(result["deadbeef0000"]).toBeNull();
  });

  it("1c. fallback glob path when pickaxe empty -> still finds + verifies the deletion", async () => {
    const commit = "111222333444111222333444111222333444abcd";
    const preimage = "revision = 'deadbeef0000'\ndown_revision = None\n";
    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      if (args[0] === "log" && args.some((a) => a.startsWith("-Sdeadbeef0000")) && args.includes("--diff-filter=D")) {
        return ok(""); // pickaxe: nothing
      }
      if (args[0] === "log" && args.includes("--diff-filter=D") && args.some((a) => a.includes("*deadbeef0000*"))) {
        return ok(
          nameStatusStdout([
            {
              commit,
              author: "Grace Hopper",
              date: "2026-01-03T00:00:00Z",
              subject: "remove file via glob-findable path",
              lines: [`D\t${VERSIONS_DIR}/deadbeef0000_old.py`],
            },
          ]),
        );
      }
      if (args[0] === "show" && args[1] === `${commit}^:${VERSIONS_DIR}/deadbeef0000_old.py`) {
        return ok(preimage);
      }
      return ok("");
    });

    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    const result = await provider.lookup([{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }]);

    expect(result["deadbeef0000"]).toMatchObject({ kind: "deleted-here", commit, deletedFilePath: `${VERSIONS_DIR}/deadbeef0000_old.py` });
  });

  it("1d. never-existed with cherry-pick body + verified foundOn on another ref", async () => {
    const introCommit = "aaa000aaa000aaa000aaa000aaa000aaa000aaa0";
    const parentSha = "bbb111bbb111bbb111bbb111bbb111bbb111bbb1";
    const childPath = `${VERSIONS_DIR}/child.py`;
    const parentPath = `${VERSIONS_DIR}/deadbeef0000_parent.py`;
    const parentContent = "revision = 'deadbeef0000'\ndown_revision = None\n";

    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      if (args[0] === "log" && args.some((a) => a.startsWith("-Sdeadbeef0000")) && args.includes("--diff-filter=D")) {
        return ok(""); // deletion pickaxe: nothing
      }
      if (args[0] === "log" && args.includes("--diff-filter=D") && args.some((a) => a.includes("*deadbeef0000*"))) {
        return ok(""); // glob fallback: nothing
      }
      if (args[0] === "log" && args.includes("-1") && args.includes("--diff-filter=A") && args.at(-1) === childPath) {
        return ok(introStdout(introCommit, "Cherry Picker", "2026-02-01T00:00:00Z", "add child", "add child\n\n(cherry picked from commit abcdefabcdefabcdefabcdefabcdefabcdefabcd)\n"));
      }
      if (args[0] === "log" && args.includes("--all") && args.some((a) => a.startsWith("-Sdeadbeef0000")) && args.includes("--diff-filter=A")) {
        return ok(
          nameStatusStdout([
            {
              commit: parentSha,
              author: "Parent Author",
              date: "2026-01-15T00:00:00Z",
              subject: "add parent on branchA",
              lines: [`A\t${parentPath}`],
            },
          ]),
        );
      }
      if (args[0] === "show" && args[1] === `${parentSha}:${parentPath}`) {
        return ok(parentContent);
      }
      if (args[0] === "branch") {
        return ok("  branchA\n");
      }
      return ok("");
    });

    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    const result = await provider.lookup([{ missingId: "deadbeef0000", childFilePath: childPath }]);

    expect(result["deadbeef0000"]).toEqual({
      kind: "never-existed",
      introducedCommit: introCommit,
      introducedShortCommit: introCommit.slice(0, 8),
      introducedAuthor: "Cherry Picker",
      introducedDate: "2026-02-01T00:00:00Z",
      introducedSubject: "add child",
      cherryPickedFrom: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      foundOn: { ref: "branchA", commit: parentSha, filePath: parentPath },
    });
  });

  it("1d2. never-existed body WITHOUT a cherry-pick trailer -> cherryPickedFrom: null", async () => {
    const introCommit = "ccc000ccc000ccc000ccc000ccc000ccc000ccc0";
    const childPath = `${VERSIONS_DIR}/child.py`;

    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      if (args[0] === "log" && args.some((a) => typeof a === "string" && a.startsWith("-S"))) return ok(""); // both pickaxe searches
      if (args[0] === "log" && args.includes("-1") && args.includes("--diff-filter=A")) {
        return ok(introStdout(introCommit, "Regular Dev", "2026-02-02T00:00:00Z", "add child normally", "add child normally\n"));
      }
      return ok("");
    });

    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    const result = await provider.lookup([{ missingId: "deadbeef0000", childFilePath: childPath }]);

    expect(result["deadbeef0000"]).toMatchObject({ kind: "never-existed", cherryPickedFrom: null, foundOn: null });
  });

  it("1e. --all search empty -> foundOn: null (still a valid never-existed result)", async () => {
    const introCommit = "ddd000ddd000ddd000ddd000ddd000ddd000ddd0";
    const childPath = `${VERSIONS_DIR}/child.py`;

    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      if (args[0] === "log" && args.some((a) => typeof a === "string" && a.startsWith("-S")) && !args.includes("--all")) return ok("");
      if (args[0] === "log" && args.includes("-1") && args.includes("--diff-filter=A")) {
        return ok(introStdout(introCommit, "Someone", "2026-02-03T00:00:00Z", "add child", "add child\n"));
      }
      if (args[0] === "log" && args.includes("--all")) return ok(""); // nothing on any other ref
      return ok("");
    });

    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    const result = await provider.lookup([{ missingId: "deadbeef0000", childFilePath: childPath }]);

    expect(result["deadbeef0000"]).toMatchObject({ kind: "never-existed", foundOn: null });
  });

  it("1f. git exec failure / not-a-repo -> { [id]: null }, never throws, logs a line", async () => {
    const log = vi.fn();
    const exec = vi.fn<ExecFn>(async () => fail("fatal: not a git repository"));
    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log, exec });

    const result = await provider.lookup([{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }]);

    expect(result).toEqual({ deadbeef0000: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not a git repository"));
  });

  it("1f2. an exec that rejects is swallowed (logged, not thrown), resolves to null", async () => {
    const log = vi.fn();
    const exec = vi.fn<ExecFn>(async () => {
      throw new Error("spawn EPERM");
    });
    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log, exec });

    const result = await provider.lookup([{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }]);

    expect(result).toEqual({ deadbeef0000: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("spawn EPERM"));
  });

  it("1g. cache: second lookup for the same id -> zero further exec calls; clearCache resets", async () => {
    const commit = "555666777888555666777888555666777888abcd";
    const preimage = "revision = 'deadbeef0000'\ndown_revision = None\n";
    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      // Explicit (non-empty) rev-parse stub: `ensureRepoRoot` now retries on every call until it
      // gets a genuine success (see gitDeletion.ts's cache-on-SUCCESS-only fix) — a real repo's
      // rev-parse always returns a non-empty path, so this models that instead of masking it behind
      // the catch-all empty-string fallback below (which would otherwise cause a repoRoot re-query
      // — and an extra exec call — on every single lookup(), defeating this test's whole point).
      if (args[0] === "rev-parse") return ok("/proj\n");
      if (args[0] === "log" && args.some((a) => a.startsWith("-Sdeadbeef0000")) && args.includes("--diff-filter=D")) {
        return ok(nameStatusStdout([{ commit, author: "A", date: "2026-01-01T00:00:00Z", subject: "s", lines: [`D\t${VERSIONS_DIR}/deadbeef0000_old.py`] }]));
      }
      if (args[0] === "show") return ok(preimage);
      return ok("");
    });

    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    const req = [{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }];

    const first = await provider.lookup(req);
    expect(first["deadbeef0000"]).toMatchObject({ kind: "deleted-here" });
    const callsAfterFirst = exec.mock.calls.length;

    const second = await provider.lookup(req);
    expect(exec.mock.calls.length).toBe(callsAfterFirst); // pure cache hit: zero new exec calls
    expect(second).toEqual(first);

    provider.clearCache();
    await provider.lookup(req);
    expect(exec.mock.calls.length).toBeGreaterThan(callsAfterFirst); // re-searched after clearCache
  });

  it("1h. two ghosts in one lookup are processed sequentially (no overlapping exec calls in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return ok(""); // every ghost resolves to "not found" -> null
    });

    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    const result = await provider.lookup([
      { missingId: "ghost0000001", childFilePath: `${VERSIONS_DIR}/a.py` },
      { missingId: "ghost0000002", childFilePath: `${VERSIONS_DIR}/b.py` },
    ]);

    expect(result).toEqual({ ghost0000001: null, ghost0000002: null });
    expect(maxInFlight).toBe(1); // strictly sequential: never more than one exec call in flight
  });

  it("getRepoRoot(): null before any lookup; resolved (trimmed) after a successful rev-parse; not re-queried on a second lookup", async () => {
    let revParseCalls = 0;
    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      if (args[0] === "rev-parse") {
        revParseCalls += 1;
        return ok("/proj\n");
      }
      return ok("");
    });
    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });
    expect(provider.getRepoRoot()).toBeNull();

    await provider.lookup([{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }]);
    expect(provider.getRepoRoot()).toBe("/proj");
    expect(revParseCalls).toBe(1);

    await provider.lookup([{ missingId: "otherghost00", childFilePath: `${VERSIONS_DIR}/child2.py` }]);
    expect(revParseCalls).toBe(1); // cached: no second rev-parse call
  });

  it("getRepoRoot(): stays null when rev-parse fails (not a repo)", async () => {
    const exec = vi.fn<ExecFn>(async () => fail());
    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });

    await provider.lookup([{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }]);
    expect(provider.getRepoRoot()).toBeNull();
  });

  it("getRepoRoot(): a TRANSIENT rev-parse failure is retried on the next lookup, not wedged null forever (carry-over fix from B1's review: cache on SUCCESS only)", async () => {
    let revParseCalls = 0;
    const exec = vi.fn<ExecFn>(async (_argv0, args) => {
      if (args[0] === "rev-parse") {
        revParseCalls += 1;
        return revParseCalls === 1 ? fail("transient: index.lock") : ok("/proj\n");
      }
      return ok("");
    });
    const provider = createGhostBlameProvider({ versionsDir: VERSIONS_DIR, log: () => {}, exec });

    await provider.lookup([{ missingId: "deadbeef0000", childFilePath: `${VERSIONS_DIR}/child.py` }]);
    expect(provider.getRepoRoot()).toBeNull(); // first attempt failed
    expect(revParseCalls).toBe(1);

    await provider.lookup([{ missingId: "otherghost00", childFilePath: `${VERSIONS_DIR}/child2.py` }]);
    expect(provider.getRepoRoot()).toBe("/proj"); // retried (not wedged) and succeeded this time
    expect(revParseCalls).toBe(2);

    // Once resolved, a THIRD lookup must not re-query — same cache-on-success behavior as before.
    await provider.lookup([{ missingId: "thirdghost00", childFilePath: `${VERSIONS_DIR}/child3.py` }]);
    expect(revParseCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Real-git integration tests (Step 8): scratch repos in os.tmpdir(), cleaned up in afterAll,
// skipped entirely if git isn't on PATH. Never touches checked-in fixtures.
// ---------------------------------------------------------------------------------------------

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runGitSync(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  runGitSync(dir, ["init", "-q"]);
  runGitSync(dir, ["config", "user.email", "test@example.com"]);
  runGitSync(dir, ["config", "user.name", "Test User"]);
}

describe.skipIf(!hasGit())("createGhostBlameProvider (real git, tmp-dir integration)", () => {
  let tmpDirs: string[] = [];

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("8a. deletion repo: commit 2 deletes a healthy-fixture revision file -> lookup finds it via real git", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-gitdel-"));
    tmpDirs.push(tmpDir);
    const projectDir = path.join(tmpDir, "proj");
    const versionsDir = path.join(projectDir, "versions");
    initRepo(projectDir);

    // Copy every *.py from the checked-in healthy fixture into the scratch repo — read-only copy,
    // the checked-in fixture itself is never touched.
    mkdirSync(versionsDir, { recursive: true });
    for (const entry of readdirSync(HEALTHY_VERSIONS).filter((f: string) => f.endsWith(".py"))) {
      writeFileSync(path.join(versionsDir, entry), readFileSync(path.join(HEALTHY_VERSIONS, entry)));
    }
    runGitSync(projectDir, ["add", "-A"]);
    runGitSync(projectDir, ["commit", "-q", "-m", "commit 1: add all revisions"]);

    // 8f2a1c9d4e07_create_products_table.py is the fixture's root revision (down_revision: None) —
    // delete it so it becomes a missing parent for b2e5d3a10f66_create_users_table.py.
    const rootFile = "8f2a1c9d4e07_create_products_table.py";
    const childFile = "b2e5d3a10f66_create_users_table.py";
    rmSync(path.join(versionsDir, rootFile));
    runGitSync(projectDir, ["add", "-A"]);
    runGitSync(projectDir, ["commit", "-q", "-m", "commit 2: delete products table revision"]);
    const deletionSha = runGitSync(projectDir, ["rev-parse", "HEAD"]).trim();

    const provider = createGhostBlameProvider({ versionsDir, log: () => {} });
    const result = await provider.lookup([
      { missingId: "8f2a1c9d4e07", childFilePath: path.join(versionsDir, childFile) },
    ]);

    const blame = result["8f2a1c9d4e07"];
    expect(blame).not.toBeNull();
    expect(blame).toMatchObject({
      kind: "deleted-here",
      commit: deletionSha,
      shortCommit: deletionSha.slice(0, 8),
      author: "Test User",
      deletedFilePath: `versions/${rootFile}`,
    });
    expect(provider.getRepoRoot()).not.toBeNull();
  });

  it("8b. two-branch cherry-pick repo: never-existed with cherryPickedFrom + foundOn, then a real restore heals it", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "alembic-graph-gitcherry-"));
    tmpDirs.push(tmpDir);
    const projectDir = path.join(tmpDir, "proj");
    const versionsDir = path.join(projectDir, "versions");
    initRepo(projectDir);
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(path.join(versionsDir, ".keep"), "keepalive\n");
    runGitSync(projectDir, ["add", "-A"]);
    runGitSync(projectDir, ["commit", "-q", "-m", "init"]);
    const baseBranch = runGitSync(projectDir, ["branch", "--show-current"]).trim();

    // Branch A: adds the parent, then the child, as two separate commits.
    runGitSync(projectDir, ["checkout", "-q", "-b", "branchA"]);
    writeFileSync(path.join(versionsDir, "aaa111111111_parent.py"), "revision = 'aaa111111111'\ndown_revision = None\n");
    runGitSync(projectDir, ["add", "-A"]);
    runGitSync(projectDir, ["commit", "-q", "-m", "add parent"]);
    const parentSha = runGitSync(projectDir, ["rev-parse", "HEAD"]).trim();

    writeFileSync(path.join(versionsDir, "bbb222222222_child.py"), "revision = 'bbb222222222'\ndown_revision = 'aaa111111111'\n");
    runGitSync(projectDir, ["add", "-A"]);
    runGitSync(projectDir, ["commit", "-q", "-m", "add child"]);
    const childShaOnA = runGitSync(projectDir, ["rev-parse", "HEAD"]).trim();

    // Branch B: from base (before parent/child existed), cherry-pick ONLY the child commit with -x.
    runGitSync(projectDir, ["checkout", "-q", "-b", "branchB", baseBranch]);
    runGitSync(projectDir, ["cherry-pick", "-x", childShaOnA]);

    const provider = createGhostBlameProvider({ versionsDir, log: () => {} });
    const result = await provider.lookup([
      { missingId: "aaa111111111", childFilePath: path.join(versionsDir, "bbb222222222_child.py") },
    ]);

    const blame = result["aaa111111111"];
    expect(blame).not.toBeNull();
    if (blame === null || blame.kind !== "never-existed") throw new Error("expected never-existed");
    expect(blame.cherryPickedFrom).toBe(childShaOnA);
    expect(blame.foundOn).not.toBeNull();
    expect(blame.foundOn!.commit).toBe(parentSha);
    expect(blame.foundOn!.filePath).toBe("versions/aaa111111111_parent.py");
    expect(blame.foundOn!.ref).toContain("branchA");

    // Real restore: bring the parent's file over from branch A's commit onto branch B's working tree.
    const repoRoot = provider.getRepoRoot();
    expect(repoRoot).not.toBeNull();
    runGitSync(repoRoot!, ["restore", `--source=${blame.foundOn!.commit}`, "--", blame.foundOn!.filePath]);

    const restoredPath = path.join(versionsDir, "aaa111111111_parent.py");
    expect(existsSync(restoredPath)).toBe(true);
    const parsed = parseRevisionSource(readFileSync(restoredPath, "utf-8"), restoredPath);
    expect(parsed?.revision).toBe("aaa111111111");
  }, 20000);
});
