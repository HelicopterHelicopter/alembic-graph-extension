/**
 * Pure helpers factored out of actions.ts specifically so they're vitest-testable: actions.ts
 * itself imports `vscode` at module scope (for showInputBox/showErrorMessage), and `vscode` isn't
 * resolvable outside a real VS Code extension host — any test importing actions.ts directly (even
 * for an unrelated named export) would fail to even load. Node-only, no `vscode`/DOM imports, same
 * rule core/*.ts and services/alembicCli.ts already follow.
 */

import type { GhostBlame as ProtocolGhostBlame } from "../protocol/messages";

/** True only when both `a` and `b` are ids in `heads` — MigrationService's current heads list at
 * the moment an action was invoked. */
export function bothAreCurrentHeads(heads: { id: string }[], a: string, b: string): boolean {
  const ids = new Set(heads.map((h) => h.id));
  return ids.has(a) && ids.has(b);
}

/** Success-toast text for a completed `alembic merge` run — alembic's own
 * "Generating <path> ... done" stdout line if present (the most specific, human-legible
 * confirmation of what actually landed on disk), else the user's own merge message as a fallback
 * (e.g. if a future alembic version changes its stdout wording). */
export function mergeSuccessText(stdout: string, message: string): string {
  const generating = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("Generating"));
  return `Merge revision created — ${generating ?? message}`;
}

/** Error-toast text for a failed CLI run — alembic's own stderr if it said anything; else (Task
 * 17) alembic's `FAILED: …` refusal line if one landed on STDOUT (alembic's util.messaging prints
 * some refusals there with stderr completely empty — e.g. `revision -m` on a multi-head project
 * says "FAILED: Multiple heads are present…" on stdout, and without this fallback the toast would
 * show Node's unreadable generic "Command failed: <full command line>" instead — proven by the
 * 7b integration test in test/unit/alembicCli.test.ts); else the run's own `error` field (e.g. a
 * spawn failure with no child process to produce any output at all). Truncated to 200 chars so a
 * runaway traceback can't blow out the toast. Shared by every actions.ts flow that runs a real
 * `alembic` subprocess and reports its failure as a toast (merge, upgrade, downgrade, revision,
 * offline SQL preview) — repointAction is the one exception, since applyRepoint's own `reason`
 * string is already toast-ready and involves no subprocess. `stdout` is optional (and only its
 * FAILED line is ever used — never arbitrary stdout, which for e.g. a failed `upgrade --sql` is
 * half-emitted SQL, not an error message) so callers passing a full RunResult pick the fallback
 * up automatically while error-only shapes keep working unchanged. */
export function cliErrorText(result: { error: string; stderr: string; stdout?: string }): string {
  const stderrText = result.stderr.trim();
  const failedLine = (result.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("FAILED"));
  const raw = stderrText.length > 0 ? stderrText : (failedLine ?? result.error);
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

/** Success-toast text for a completed ghost-drag repoint (matches the design file's `repoint()`
 * toast wording, `design/Alembic Graph.dc.html`). */
export function repointSuccessText(targetId: string): string {
  return `Re-pointed down_revision → ${targetId.slice(0, 8)} · broken link fixed`;
}

/** Task B2 ghost-card restore/import: pure decision logic for git-restore's source commit and
 * path, factored out of restoreDeletedAction (src/ui/actions.ts) for unit testing. Given a
 * GhostBlame, returns either { source, path } ready for `git restore --source=<source> -- <path>`,
 * or { error } with a toast-ready message. `source` is the commit to restore FROM (preface with
 * `^` for deleted-here's parent; never preface foundOn's commit). `path` is repo-root-relative. */
export function restoreSource(
  blame: ProtocolGhostBlame,
): { source: string; path: string } | { error: string } {
  // deleted-here: restore from the DELETING commit's parent (the last commit where file existed)
  if (blame.kind === "deleted-here") {
    return {
      source: `${blame.commit}^`,
      path: blame.deletedFilePath,
    };
  }

  // never-existed with foundOn: import straight from the defining commit (no ^)
  if (blame.foundOn) {
    return {
      source: blame.foundOn.commit,
      path: blame.foundOn.filePath,
    };
  }

  // never-existed without foundOn: no source — return error (toast text from actions.ts)
  return {
    error: "The missing revision isn't found on any ref — fetch the source branch or drag to re-point.",
  };
}
