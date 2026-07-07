/**
 * Blame for a missing (`ghost`) revision id: finds either the commit that DELETED the file that
 * used to define it (→ Task B2's one-click Restore), or — when no such deletion ever happened on
 * this branch — the commit that INTRODUCED the broken reference plus, if findable, a commit on
 * some OTHER ref that still defines the missing revision (→ Task B2's one-click Import). This is
 * the "cherry-pick / partial sync" case: a commit was cherry-picked onto this branch whose
 * `down_revision` parent was never itself synced here, so there is no local deletion to blame.
 *
 * Same architecture rule as gitAuthor.ts/alembicCli.ts: no `vscode` import, so this is fully
 * vitest-testable via an injected `exec`, wired up with the real child_process in extension.ts.
 *
 * Golden rule (same one gitAuthor.ts/alembicCli.ts follow): NEVER throws. Not a git repo, git
 * missing from PATH, a shallow clone that can't see the deleting commit, or any other failure all
 * resolve to `null` for that missing id — logged once, never surfaced as an exception. The caller
 * (MigrationService) treats an absent/null map entry as "no blame known", indistinguishably from
 * "will never be known".
 *
 * Search algorithm (see docs/superpowers/specs/2026-07-07-broken-link-blame-design.md for the
 * full rationale):
 *   1. Pickaxe: `git log -S<id> --diff-filter=D ... --name-status -- <versionsDir>`, newest first.
 *   2. Verify each candidate by reading the PRE-image (`git show <sha>^:<path>`) and parsing it
 *      with the real parser — accepts only a commit that DELETED THE FILE DEFINING <id> (rejects
 *      a commit that merely deleted some other file that referenced <id> as its down_revision).
 *   3. Fallback: same verification, but candidates come from a filename-glob pickaxe instead of a
 *      content pickaxe (guards against shallow-clone/content-search quirks).
 *   4. Never-existed-here fallback, when 1–3 find nothing: blame the introduction of the broken
 *      CHILD file (detecting a `(cherry picked from commit ...)` trailer), then search every ref
 *      (`--all`) for a commit that ADDED a file defining <id> — verified the same way as a
 *      deletion, just against the post-image instead of the pre-image.
 *
 * No concurrency gate (unlike gitAuthor.ts's bounded worker pool): `lookup()` walks its requests
 * with a plain sequential loop. Ghosts are rare (most scans have zero), and each one can run
 * several git subprocesses in its own search chain — running many of THOSE chains in parallel
 * would multiply an already multi-step cost instead of paying it once each; sequential keeps the
 * process count bounded without needing a second gate on top of the multi-step search itself.
 */
import { execFile } from "node:child_process";
import { parseRevisionSource } from "../core/parser";
import type { GhostBlame } from "../protocol/messages";

export type ExecResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string; stdout: string; stderr: string };

/** Mirrors alembicCli.ts's `ExecFn` shape exactly (same field names), declared locally so this
 * file has no dependency on alembicCli.ts — same independence gitAuthor.ts's own `GitExecFn`
 * keeps despite following the same conventions. */
export type ExecFn = (
  argv0: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<ExecResult>;

const TIMEOUT_MS = 10000;

/** Default ExecFn: child_process.execFile, never rejects (mirrors alembicCli.ts's defaultExec). */
function defaultExec(argv0: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        argv0,
        args,
        { cwd: opts.cwd, timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ ok: true, stdout, stderr });
            return;
          }
          resolve({ ok: false, error: err instanceof Error ? err.message : String(err), stdout, stderr });
        },
      );
    } catch (err) {
      // execFile itself throws synchronously only in pathological cases — same defensive catch
      // alembicCli.ts's/gitAuthor.ts's defaultExec use.
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err), stdout: "", stderr: "" });
    }
  });
}

export interface GhostBlameProvider {
  /**
   * Resolves to exactly one entry per request id — `null` when searched-and-not-found (or every
   * underlying git call failed); never a thrown/rejected promise. Cached per `missingId` (a repeat
   * lookup, hit OR miss, never re-runs the search) — see `clearCache()`.
   */
  lookup(requests: { missingId: string; childFilePath: string }[]): Promise<Record<string, GhostBlame | null>>;
  /** Repo root cached once resolved via `git rev-parse --show-toplevel` — null until that
   * succeeds. Failed attempts retry on later calls. Used later by Task B2's restore/import action,
   * which needs an absolute cwd to run `git restore` from; never sent over postMessage. */
  getRepoRoot(): string | null;
  /** Drops every cached blame entry — a repeat lookup afterward re-runs the full search chain for
   * every id. Does NOT reset the cached repo root (that's a property of the repo/versionsDir, not
   * of any one search result). */
  clearCache(): void;
}

/** One parsed `git log --name-status` record: the commit's own fields plus its raw `STATUS\tpath`
 * lines (blank lines already stripped). */
interface NameStatusRecord {
  commit: string;
  author: string;
  date: string;
  subject: string;
  statusLines: string[];
}

/**
 * Parses `git log --format=%H%x00%an%x00%aI%x00%s --name-status ...` output (newest-first, one or
 * more commits) into structured records.
 *
 * The tricky part: git inserts NO separator at all between one commit's trailing name-status
 * lines and the NEXT commit's `%H` — only the fields WITHIN a single commit's `%format` are
 * NUL-separated. So splitting the whole blob on `\0` yields, per commit, three clean fields
 * (author/date are always clean) but a fourth chunk that's "subject + blank + status lines +
 * (glued on, no separator) the NEXT commit's raw sha" for every commit except the last. This walks
 * that structure explicitly rather than assuming a fixed-width record.
 */
function parseNameStatusLog(stdout: string): NameStatusRecord[] {
  if (stdout.trim().length === 0) return [];
  const parts = stdout.split("\0");
  const records: NameStatusRecord[] = [];

  let currentCommit: string | undefined = parts[0]?.trim();
  let idx = 1;
  // parts[idx], parts[idx+1], parts[idx+2] must all exist -> idx+2 <= parts.length-1.
  while (currentCommit && idx + 3 <= parts.length) {
    const author = parts[idx];
    const date = parts[idx + 1];
    const tail = parts[idx + 2]; // subject + "\n\n" + status lines + (maybe) next commit's raw sha
    const lines = tail.split("\n");
    const subject = lines[0] ?? "";
    const rest = lines.slice(2); // lines[1] is the blank separator line

    // If more parts follow this record's tail, the LAST line of `rest` isn't a status line at all
    // — it's the next commit's bare sha, glued on with no separating NUL. Pop it off before
    // filtering status lines.
    let nextCommit: string | undefined;
    if (idx + 3 < parts.length) {
      nextCommit = rest.pop();
    }

    records.push({ commit: currentCommit, author, date, subject, statusLines: rest.filter((l) => l.length > 0) });
    currentCommit = nextCommit;
    idx += 3;
  }

  return records;
}

/** Splits a `STATUS\tpath` name-status line; null if it doesn't match that shape at all. */
function splitStatusLine(line: string): { status: string; path: string } | null {
  const tab = line.indexOf("\t");
  if (tab === -1) return null;
  return { status: line.slice(0, tab), path: line.slice(tab + 1) };
}

/** First non-blank line of `git branch -a --contains <sha>`, with the `* ` current-branch marker
 * (if present) and surrounding whitespace stripped. Null if there's no non-blank line at all. */
function firstBranchLine(stdout: string): string | null {
  for (const raw of stdout.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed.replace(/^\*\s*/, "");
  }
  return null;
}

const CHERRY_PICK_RE = /\(cherry picked from commit ([0-9a-f]+)\)/;

export function createGhostBlameProvider(opts: {
  versionsDir: string;
  log: (line: string) => void;
  exec?: ExecFn;
}): GhostBlameProvider {
  const exec = opts.exec ?? defaultExec;
  const versionsDir = opts.versionsDir;
  const cache = new Map<string, GhostBlame | null>();

  let repoRoot: string | null = null;

  function onError(message: string): void {
    opts.log(`gitDeletion: ${message}`);
  }

  /** Runs one git subcommand; resolves its stdout on success, or `null` (+ one log line) on ANY
   * failure — a non-zero exit, git missing, not a repo, or the exec itself throwing. Never throws. */
  async function runGit(args: string[], cwd: string): Promise<string | null> {
    let result: ExecResult;
    try {
      result = await exec("git", args, { cwd, timeoutMs: TIMEOUT_MS });
    } catch (err) {
      onError(`git ${args.join(" ")} threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (!result.ok) {
      onError(`git ${args.join(" ")} failed: ${result.error}`);
      return null;
    }
    return result.stdout;
  }

  /** Cache-on-SUCCESS only (carry-over fix from Task B1's review): a transient first-call failure
   * (e.g. a momentary `index.lock`, or the versions dir not existing yet during a race at startup)
   * must not wedge `repoRoot` at null for the rest of the session — every call here re-attempts
   * `rev-parse` until one actually succeeds. Once it does, `repoRoot !== null` short-circuits every
   * later call, so a real repo only ever pays for this once. A failed rev-parse is cheap (git exits
   * fast on "not a repository"), so retrying it once per lookup batch until it resolves costs
   * nothing meaningful — the alternative (caching the failure) is what let Task B2's restore action
   * depend on a `getRepoRoot()` that could be permanently null after one bad first call. */
  async function ensureRepoRoot(): Promise<void> {
    if (repoRoot !== null) return;
    const stdout = await runGit(["rev-parse", "--show-toplevel"], versionsDir);
    if (stdout !== null && stdout.trim().length > 0) repoRoot = stdout.trim();
  }

  /** Shared verification step for both deletion candidates (pre-image, `<sha>^:<path>`) and
   * introduction candidates (post-image, `<sha>:<path>`): the file's content at that revision must
   * itself DEFINE `revision == missingId` (not merely reference it), or the candidate is rejected
   * and the caller moves on to the next one. */
  async function verifyContentDefines(showArg: string, path: string, missingId: string): Promise<boolean> {
    const content = await runGit(["show", showArg], versionsDir);
    if (content === null) return false;
    const parsed = parseRevisionSource(content, path);
    return parsed !== null && parsed.revision === missingId;
  }

  async function verifyDeletionCandidates(records: NameStatusRecord[], missingId: string): Promise<GhostBlame | null> {
    for (const rec of records) {
      for (const line of rec.statusLines) {
        const split = splitStatusLine(line);
        if (split === null || split.status !== "D") continue;
        const verified = await verifyContentDefines(`${rec.commit}^:${split.path}`, split.path, missingId);
        if (!verified) continue;
        return {
          kind: "deleted-here",
          commit: rec.commit,
          shortCommit: rec.commit.slice(0, 8),
          author: rec.author,
          date: rec.date,
          subject: rec.subject,
          deletedFilePath: split.path,
        };
      }
    }
    return null;
  }

  async function searchDeletionPickaxe(missingId: string): Promise<GhostBlame | null> {
    const stdout = await runGit(
      ["log", `-S${missingId}`, "--diff-filter=D", "--format=%H%x00%an%x00%aI%x00%s", "--name-status", "--", versionsDir],
      versionsDir,
    );
    if (stdout === null) return null;
    return verifyDeletionCandidates(parseNameStatusLog(stdout), missingId);
  }

  async function searchDeletionGlob(missingId: string): Promise<GhostBlame | null> {
    const pattern = `${versionsDir}/*${missingId}*`;
    const stdout = await runGit(
      ["log", "--diff-filter=D", "--format=%H%x00%an%x00%aI%x00%s", "--name-status", "--", pattern],
      versionsDir,
    );
    if (stdout === null) return null;
    return verifyDeletionCandidates(parseNameStatusLog(stdout), missingId);
  }

  async function searchAcrossRefs(missingId: string): Promise<{ ref: string; commit: string; filePath: string } | null> {
    const stdout = await runGit(
      [
        "log",
        "--all",
        `-S${missingId}`,
        "--diff-filter=A",
        "--format=%H%x00%an%x00%aI%x00%s",
        "--name-status",
        "--",
        versionsDir,
      ],
      versionsDir,
    );
    if (stdout === null) return null;

    for (const rec of parseNameStatusLog(stdout)) {
      for (const line of rec.statusLines) {
        const split = splitStatusLine(line);
        if (split === null || split.status !== "A") continue;
        const verified = await verifyContentDefines(`${rec.commit}:${split.path}`, split.path, missingId);
        if (!verified) continue;

        const branchStdout = await runGit(["branch", "-a", "--contains", rec.commit], versionsDir);
        const ref = branchStdout !== null ? firstBranchLine(branchStdout) : null;
        if (ref === null) continue; // found the content but couldn't resolve a display ref — skip

        return { ref, commit: rec.commit, filePath: split.path };
      }
    }
    return null;
  }

  async function searchNeverExisted(missingId: string, childFilePath: string): Promise<GhostBlame | null> {
    const stdout = await runGit(
      ["log", "-1", "--diff-filter=A", "--format=%H%x00%an%x00%aI%x00%s%x00%B", "--", childFilePath],
      versionsDir,
    );
    if (stdout === null || stdout.trim().length === 0) return null;

    const parts = stdout.split("\0");
    if (parts.length < 5) return null;
    const [commit, author, date, subject, ...bodyParts] = parts;
    const body = bodyParts.join("\0"); // defensive: %B shouldn't itself contain a NUL, but don't truncate if it did

    const cherryMatch = CHERRY_PICK_RE.exec(body);
    const cherryPickedFrom = cherryMatch ? cherryMatch[1] : null;

    const foundOn = await searchAcrossRefs(missingId);

    return {
      kind: "never-existed",
      introducedCommit: commit,
      introducedShortCommit: commit.slice(0, 8),
      introducedAuthor: author,
      introducedDate: date,
      introducedSubject: subject,
      cherryPickedFrom,
      foundOn,
    };
  }

  async function findBlame(missingId: string, childFilePath: string): Promise<GhostBlame | null> {
    try {
      const pickaxeHit = await searchDeletionPickaxe(missingId);
      if (pickaxeHit) return pickaxeHit;

      const globHit = await searchDeletionGlob(missingId);
      if (globHit) return globHit;

      return await searchNeverExisted(missingId, childFilePath);
    } catch (err) {
      // Defensive only: every step above already swallows its own git failures via runGit(); this
      // catches anything genuinely unexpected (e.g. a pathological parser input) so ONE ghost's
      // search can never take down the whole batch.
      onError(`unexpected error searching blame for ${missingId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async function lookup(requests: { missingId: string; childFilePath: string }[]): Promise<Record<string, GhostBlame | null>> {
    await ensureRepoRoot();

    const result: Record<string, GhostBlame | null> = {};
    // Sequential on purpose — see this module's doc comment for why no concurrency gate is needed.
    for (const { missingId, childFilePath } of requests) {
      if (cache.has(missingId)) {
        result[missingId] = cache.get(missingId) ?? null;
        continue;
      }
      const blame = await findBlame(missingId, childFilePath);
      cache.set(missingId, blame);
      result[missingId] = blame;
    }
    return result;
  }

  return {
    lookup,
    getRepoRoot() {
      return repoRoot;
    },
    clearCache() {
      cache.clear();
    },
  };
}
