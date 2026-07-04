import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createAuthorProvider, type GitExecFn } from "../../src/services/gitAuthor";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../..");
// This fixture file is checked into THIS git repo (Task 1) — a real `git log` against it resolves
// to a real author, proving the default (non-injected) exec path end to end.
const REAL_FIXTURE_FILE = path.join(
  REPO_ROOT,
  "fixtures/broken-project/alembic/versions/8f2a1c9d4e07_create_products_table.py",
);

describe("createAuthorProvider (injected fake exec)", () => {
  it("1. resolves an author per file from the fake exec's stdout, trimmed", async () => {
    const exec = vi.fn<GitExecFn>(async (_argv0, args) => {
      const idx = args.indexOf("--");
      const file = args[idx + 1];
      return { ok: true, stdout: `  Author For ${file}  \n` };
    });
    const provider = createAuthorProvider(() => {}, exec);

    const result = await provider.lookup(["/proj/a.py", "/proj/b.py"]);
    expect(result.get("/proj/a.py")).toBe("Author For a.py");
    expect(result.get("/proj/b.py")).toBe("Author For b.py");
  });

  it("2. empty stdout -> that file is absent from the result map (not an empty-string entry)", async () => {
    const exec = vi.fn<GitExecFn>(async () => ({ ok: true, stdout: "   \n" }));
    const provider = createAuthorProvider(() => {}, exec);

    const result = await provider.lookup(["/proj/a.py"]);
    expect(result.has("/proj/a.py")).toBe(false);
  });

  it("3. per-path cache: a second lookup for the same path does not call exec again", async () => {
    const exec = vi.fn<GitExecFn>(async () => ({ ok: true, stdout: "Ada Lovelace\n" }));
    const provider = createAuthorProvider(() => {}, exec);

    await provider.lookup(["/proj/a.py", "/proj/b.py"]);
    expect(exec).toHaveBeenCalledTimes(2);

    const result = await provider.lookup(["/proj/a.py", "/proj/b.py", "/proj/c.py"]);
    expect(exec).toHaveBeenCalledTimes(3); // only the new path (c.py) triggers a call
    expect(result.get("/proj/a.py")).toBe("Ada Lovelace");
    expect(result.get("/proj/c.py")).toBe("Ada Lovelace");
  });

  it("3b. a cached known-unknown path (git failure) is also a cache hit on repeat lookup", async () => {
    const exec = vi.fn<GitExecFn>(async () => ({ ok: false, stdout: "" }));
    const provider = createAuthorProvider(() => {}, exec);

    await provider.lookup(["/proj/a.py"]);
    await provider.lookup(["/proj/a.py"]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("4. concurrency cap: at most 8 exec calls are ever in flight at once, for 30 files", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = vi.fn<GitExecFn>(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield a real tick so overlapping calls actually race, instead of resolving synchronously
      // (which would never let concurrent callers pile up in the first place).
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, stdout: "Someone\n" };
    });
    const provider = createAuthorProvider(() => {}, exec);

    const files = Array.from({ length: 30 }, (_, i) => `/proj/file${i}.py`);
    const result = await provider.lookup(files);

    expect(exec).toHaveBeenCalledTimes(30);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1); // sanity: this actually exercised concurrency, not serial
    expect(result.size).toBe(30);
  });

  it("4b. the cap is GLOBAL to the provider, not per-call: two overlapping lookup() calls for disjoint files together still never exceed 8 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = vi.fn<GitExecFn>(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, stdout: "Someone\n" };
    });
    const provider = createAuthorProvider(() => {}, exec);

    // Two separate lookup() calls fired back-to-back without awaiting the first — mirrors two
    // overlapping MigrationService doRefresh() cycles each firing their own fetchAuthors() batch.
    // If the cap were reset per-call (the bug this test guards against), up to 16 could overlap.
    const batchA = Array.from({ length: 15 }, (_, i) => `/proj/a/file${i}.py`);
    const batchB = Array.from({ length: 15 }, (_, i) => `/proj/b/file${i}.py`);

    const [resultA, resultB] = await Promise.all([provider.lookup(batchA), provider.lookup(batchB)]);

    expect(exec).toHaveBeenCalledTimes(30);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(resultA.size).toBe(15);
    expect(resultB.size).toBe(15);
  });

  it("4c. cache hits never touch the concurrency gate: a fully-cached repeat batch resolves without any exec calls, even overlapping a fresh batch still spawning up to 8", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = vi.fn<GitExecFn>(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, stdout: "Someone\n" };
    });
    const provider = createAuthorProvider(() => {}, exec);

    const cachedFiles = Array.from({ length: 5 }, (_, i) => `/proj/cached${i}.py`);
    await provider.lookup(cachedFiles); // warm the cache
    expect(exec).toHaveBeenCalledTimes(5);

    const freshFiles = Array.from({ length: 10 }, (_, i) => `/proj/fresh${i}.py`);
    const [cachedAgain, fresh] = await Promise.all([provider.lookup(cachedFiles), provider.lookup(freshFiles)]);

    expect(exec).toHaveBeenCalledTimes(15); // only the 10 fresh files spawned anything new
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(cachedAgain.size).toBe(5);
    expect(fresh.size).toBe(10);
  });

  it("5. git missing/failing for every file -> all undefined (empty result map), never throws", async () => {
    const exec = vi.fn<GitExecFn>(async () => ({ ok: false, stdout: "" }));
    const provider = createAuthorProvider(() => {}, exec);

    const result = await provider.lookup(["/proj/a.py", "/proj/b.py"]);
    expect(result.size).toBe(0);
  });

  it("6. an exec that rejects is swallowed (logged, not thrown) and that path resolves to unknown", async () => {
    const log = vi.fn();
    const exec = vi.fn<GitExecFn>(async () => {
      throw new Error("spawn EPERM");
    });
    const provider = createAuthorProvider(log, exec);

    const result = await provider.lookup(["/proj/a.py"]);
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("spawn EPERM"));
  });

  it("7. clearCache() forces a re-lookup (exec is called again for a previously-resolved path)", async () => {
    const exec = vi.fn<GitExecFn>(async () => ({ ok: true, stdout: "Ada Lovelace\n" }));
    const provider = createAuthorProvider(() => {}, exec);

    await provider.lookup(["/proj/a.py"]);
    expect(exec).toHaveBeenCalledTimes(1);

    provider.clearCache();
    await provider.lookup(["/proj/a.py"]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("8. calls git with the exact argv the brief specifies, cwd'd to the file's own directory", async () => {
    const exec = vi.fn<GitExecFn>(async () => ({ ok: true, stdout: "Someone\n" }));
    const provider = createAuthorProvider(() => {}, exec);

    await provider.lookup(["/proj/versions/abc123_add_table.py"]);

    expect(exec).toHaveBeenCalledWith("git", ["log", "-1", "--format=%an", "--", "abc123_add_table.py"], {
      cwd: "/proj/versions",
    });
  });

  it("9. empty input -> empty map, no exec calls", async () => {
    const exec = vi.fn<GitExecFn>(async () => ({ ok: true, stdout: "Someone\n" }));
    const provider = createAuthorProvider(() => {}, exec);

    const result = await provider.lookup([]);
    expect(result.size).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("createAuthorProvider (real default exec, real git)", () => {
  it("10. a file checked into THIS repo resolves to a real, non-empty author via real git log", async () => {
    const provider = createAuthorProvider(() => {});
    const result = await provider.lookup([REAL_FIXTURE_FILE]);

    const author = result.get(REAL_FIXTURE_FILE);
    expect(author).toBeDefined();
    expect(author!.length).toBeGreaterThan(0);
  });

  it("11. a file outside any git repo (or in a nonexistent directory) resolves to unknown, not a throw", async () => {
    const provider = createAuthorProvider(() => {});
    const outsideFile = path.join(os.tmpdir(), "definitely-not-a-repo-dir-xyz", "whatever.py");

    const result = await provider.lookup([outsideFile]);
    expect(result.has(outsideFile)).toBe(false);
  });
});
