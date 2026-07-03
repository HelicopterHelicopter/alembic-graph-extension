/**
 * Runs the `alembic` CLI as a child process for ACTIONS and DB-state queries only — never for
 * reading migration history (core/parser.ts + core/graph.ts own that, statically, from the
 * versions/*.py files on disk). This is the extension's one boundary onto an untrusted external
 * process: a missing interpreter, a missing `alembic` package, an unreachable DB, or a broken
 * revision chain that crashes alembic itself must all degrade silently (logged, never thrown,
 * never surfaced as a user-facing error) — see AlembicCli.current().
 *
 * Node-only (no `vscode` import) so this is fully vitest-testable; wired up with a real
 * interpreter path by pythonEnv.ts + extension.ts.
 */
import { execFile } from "node:child_process";

export interface AlembicCommand {
  argv0: string;
  prefixArgs: string[];
}

/**
 * Precedence: a non-empty override setting (whitespace-split: first token is argv0, the rest are
 * prefix args, e.g. `"poetry run alembic"` -> `poetry run alembic <args>`) beats a resolved
 * interpreter path (`<pythonPath> -m alembic <args>`), which beats a bare `alembic` on PATH.
 */
export function resolveCommand(opts: { override: string; pythonPath: string | null }): AlembicCommand {
  const trimmedOverride = opts.override.trim();
  if (trimmedOverride.length > 0) {
    const [argv0, ...prefixArgs] = trimmedOverride.split(/\s+/);
    return { argv0, prefixArgs };
  }
  if (opts.pythonPath !== null) {
    return { argv0: opts.pythonPath, prefixArgs: ["-m", "alembic"] };
  }
  return { argv0: "alembic", prefixArgs: [] };
}

/**
 * Pure: parse `alembic current` stdout into revision ids. A line contributes its id if, once
 * trimmed, it matches /^([0-9a-f]+)(?:\s.*)?$/i — i.e. it starts with a run of hex digits followed
 * by nothing or whitespace-then-anything (covers alembic's `<id> (head)` / `<id> (effective
 * head)` / bare `<id>` formats). Everything else (blank lines, `INFO [alembic...] ...` logging,
 * warnings, tracebacks) is ignored. Empty stdout -> [].
 */
export function parseCurrentOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^([0-9a-f]+)(?:\s.*)?$/i.exec(line);
    if (match !== null) ids.push(match[1]);
  }
  return ids;
}

export type RunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string; stdout: string; stderr: string };

export type ExecFn = (
  argv0: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 30000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default ExecFn: child_process.execFile with a cwd + kill-on-timeout. Never throws/rejects —
 * every outcome (success, non-zero exit, spawn failure, timeout) resolves a RunResult. Node sets
 * `error.killed === true` specifically when ITS OWN timeout (or maxBuffer) mechanism killed the
 * child (as opposed to a plain non-zero exit, where `killed` is false) — that's what distinguishes
 * the timeout case below.
 */
function defaultExec(argv0: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<RunResult> {
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
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          const error = killed ? `timed out after ${opts.timeoutMs}ms` : errorMessage(err);
          resolve({ ok: false, error, stdout, stderr });
        },
      );
    } catch (err) {
      // execFile itself throws synchronously only in pathological cases (e.g. bad options); the
      // callback form covers spawn failures like a missing binary (ENOENT) via `err` above.
      resolve({ ok: false, error: errorMessage(err), stdout: "", stderr: "" });
    }
  });
}

export class AlembicCli {
  private readonly cwd: string;
  private readonly resolve: () => Promise<AlembicCommand>;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly exec: ExecFn;

  /**
   * Single-flight mutex: every run() chains onto this promise, so at most one child process is
   * ever active and concurrent callers queue FIFO. The chained continuation always swallows its
   * own outcome (never rejects) so one failing run can never wedge every run() call after it.
   */
  private mutex: Promise<void> = Promise.resolve();

  constructor(opts: {
    cwd: string;
    resolve: () => Promise<AlembicCommand>;
    log: (line: string) => void;
    timeoutMs?: number;
    exec?: ExecFn;
  }) {
    this.cwd = opts.cwd;
    this.resolve = opts.resolve;
    this.log = opts.log;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exec = opts.exec ?? defaultExec;
  }

  /** Runs `<resolved command> ...args`, queued behind any run() already in flight. Never throws. */
  run(args: string[]): Promise<RunResult> {
    const task = this.mutex.then(() => this.runNow(args));
    this.mutex = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async runNow(args: string[]): Promise<RunResult> {
    let command: AlembicCommand;
    try {
      command = await this.resolve();
    } catch (err) {
      const error = `failed to resolve alembic command: ${errorMessage(err)}`;
      this.log(error);
      return { ok: false, error, stdout: "", stderr: "" };
    }

    const fullArgs = [...command.prefixArgs, ...args];
    this.log(`$ ${command.argv0} ${fullArgs.join(" ")} (${this.cwd})`);

    let result: RunResult;
    try {
      result = await this.exec(command.argv0, fullArgs, { cwd: this.cwd, timeoutMs: this.timeoutMs });
    } catch (err) {
      // Defensive only: the default exec never rejects, but an injected test/custom ExecFn might.
      result = { ok: false, error: errorMessage(err), stdout: "", stderr: "" };
    }

    if (result.ok) {
      this.log("  exit 0");
    } else {
      this.log(`  ${result.error}`);
    }
    if (result.stderr.trim().length > 0) this.log(result.stderr.trimEnd());

    return result;
  }

  /**
   * `alembic current`. Any failure (missing alembic, unreachable DB, a broken revision chain
   * crashing alembic itself, ...) degrades silently to `dbReachable: false` — never throws, never
   * surfaces a user-facing error. This is the extension's one gate between "the DB said X" and
   * "we don't know" — callers must treat the latter as fully distinct from an empty applied set.
   */
  async current(): Promise<{ dbReachable: true; currentIds: string[] } | { dbReachable: false }> {
    const result = await this.run(["current"]);
    if (!result.ok) return { dbReachable: false };
    return { dbReachable: true, currentIds: parseCurrentOutput(result.stdout) };
  }
}
