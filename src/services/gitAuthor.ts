/**
 * Batch git author lookup: revision file -> its most recent commit's author name, via one
 * `git log -1 --format=%an -- <basename>` per file (run with `cwd` = the file's own directory, so
 * a bare basename is enough — no need to know the repo root or the file's path relative to it).
 *
 * Node-only (no `vscode` import), same rule as alembicCli.ts: fully vitest-testable via an
 * injected exec function, wired up with the real child_process in extension.ts.
 *
 * Golden rule (same one alembicCli.ts follows): never throws. A file outside any git repo, git
 * itself missing from PATH, a file with no commit history, or any other failure all resolve to
 * "no author known" for that file — the caller (MigrationService) treats an absent map entry as
 * "not yet known" indistinguishably from "never will be known".
 */
import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";

export interface GitExecResult {
  ok: boolean;
  stdout: string;
}

export type GitExecFn = (argv0: string, args: string[], opts: { cwd: string }) => Promise<GitExecResult>;

/** Concurrency cap: at most this many `git log` child processes in flight at once, even for a
 * versions dir with hundreds of files — keeps a big scan from forking an unbounded process storm. */
const CONCURRENCY = 8;
const TIMEOUT_MS = 5000;

/** Default GitExecFn: child_process.execFile, never rejects (mirrors alembicCli.ts's defaultExec).
 * A non-zero exit (not a git repo, no history for this path) or a missing `git` binary both land
 * in the `ok:false` branch — the caller doesn't need to distinguish them, both mean "no author". */
function defaultExec(argv0: string, args: string[], opts: { cwd: string }): Promise<GitExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(argv0, args, { cwd: opts.cwd, timeout: TIMEOUT_MS }, (err, stdout) => {
        if (err !== null) {
          resolve({ ok: false, stdout: "" });
          return;
        }
        resolve({ ok: true, stdout });
      });
    } catch {
      // execFile itself throws synchronously only in pathological cases (bad options) — same
      // defensive catch as alembicCli.ts's defaultExec.
      resolve({ ok: false, stdout: "" });
    }
  });
}

export interface AuthorProvider {
  /**
   * Resolves to a Map containing only the file paths an author was actually found for — a path
   * absent from the result means "unknown" (outside a git repo, git missing, no history, or a
   * blank author line), never a thrown/rejected promise. Concurrency-capped and cached per path
   * (a repeat lookup for a path already resolved, hit OR miss, never spawns another process).
   */
  lookup(filePaths: string[]): Promise<Map<string, string>>;
  /** Drops every cached entry — a repeat lookup afterward re-runs `git log` for every path. Not
   * called anywhere yet (no cache-invalidation trigger exists), but exposed for tests and for any
   * future "author changed underneath us" scenario. */
  clearCache(): void;
}

/** Batch author lookup with a per-path cache and a bounded-concurrency gate. `log` receives one
 * line per unexpected (non-git-failure) error — actual git failures (missing repo, missing binary)
 * are expected/silent, per the golden rule above. */
export function createAuthorProvider(log: (line: string) => void, exec: GitExecFn = defaultExec): AuthorProvider {
  // undefined means "looked up, no author found" — distinct from "never looked up" (absent key) so
  // a repeat lookup for a known-unknown path is still a cache hit, not a re-spawn.
  const cache = new Map<string, string | undefined>();

  // Concurrency gate is a property of the PROVIDER, not of any one `lookup()` call — a code review
  // caught that an earlier version capped concurrency only WITHIN a single call (a fresh worker
  // pool built per `lookup()` invocation), so two overlapping `lookup()` batches (e.g.
  // MigrationService's trailing-refresh coalescing can fire a second scan, with its own
  // `fetchAuthors`, while an earlier scan's is still in flight) could together spawn up to 2x (or
  // more, for further overlaps) CONCURRENCY processes at once. `activeCount`/`waiters` are shared
  // across every `lookup()` call this provider instance ever makes, so the cap is truly global.
  let activeCount = 0;
  const waiters: (() => void)[] = [];

  function acquire(): Promise<void> {
    if (activeCount < CONCURRENCY) {
      activeCount += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release(): void {
    activeCount -= 1;
    const next = waiters.shift();
    if (next !== undefined) {
      activeCount += 1;
      next();
    }
  }

  async function lookupOne(filePath: string): Promise<string | undefined> {
    if (cache.has(filePath)) return cache.get(filePath); // cache hit: never touches the gate at all

    await acquire();
    try {
      let author: string | undefined;
      try {
        const result = await exec("git", ["log", "-1", "--format=%an", "--", basename(filePath)], {
          cwd: dirname(filePath),
        });
        const trimmed = result.ok ? result.stdout.trim() : "";
        author = trimmed.length > 0 ? trimmed : undefined;
      } catch (err) {
        // Defensive only — both the default exec and every injected test fake resolve rather than
        // reject, but a custom GitExecFn might not.
        log(`git author lookup failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        author = undefined;
      }
      cache.set(filePath, author);
      return author;
    } finally {
      release();
    }
  }

  async function lookup(filePaths: string[]): Promise<Map<string, string>> {
    // Every path is kicked off "at once" (no per-call worker pool/queue needed): a cache hit
    // resolves immediately without ever touching the concurrency gate, and a cache miss awaits
    // `acquire()` above, which is what actually serializes anything past `CONCURRENCY` in flight —
    // globally, across every concurrent `lookup()` call this provider instance has outstanding.
    const entries = await Promise.all(
      filePaths.map(async (filePath) => [filePath, await lookupOne(filePath)] as const),
    );

    const result = new Map<string, string>();
    for (const [filePath, author] of entries) {
      if (author !== undefined) result.set(filePath, author);
    }
    return result;
  }

  return {
    lookup,
    clearCache() {
      cache.clear();
    },
  };
}
