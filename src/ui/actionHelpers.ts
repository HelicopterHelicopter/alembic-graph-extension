/**
 * Pure helpers factored out of actions.ts specifically so they're vitest-testable: actions.ts
 * itself imports `vscode` at module scope (for showInputBox/showErrorMessage), and `vscode` isn't
 * resolvable outside a real VS Code extension host — any test importing actions.ts directly (even
 * for an unrelated named export) would fail to even load. Node-only, no `vscode`/DOM imports, same
 * rule core/*.ts and services/alembicCli.ts already follow.
 */

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

/** Error-toast text for a failed CLI run — alembic's own stderr if it said anything, else the
 * run's own `error` field (e.g. a spawn failure with no child process to produce stderr at all) —
 * truncated to 200 chars so a runaway traceback can't blow out the toast. */
export function mergeErrorText(result: { error: string; stderr: string }): string {
  const raw = result.stderr.trim().length > 0 ? result.stderr.trim() : result.error;
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

/** Success-toast text for a completed ghost-drag repoint (matches the design file's `repoint()`
 * toast wording, `design/Alembic Graph.dc.html`). */
export function repointSuccessText(targetId: string): string {
  return `Re-pointed down_revision → ${targetId.slice(0, 8)} · broken link fixed`;
}
