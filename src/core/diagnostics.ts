/**
 * Pure diagnostic-building logic: turns graph `Problem`s (core/types.ts) into a per-file list of
 * {line, message} entries, ready for a thin vscode.Diagnostic wrapper (src/services/diagnostics.ts)
 * to construct. Same purity rule as the rest of core/*.ts — no `vscode`/`node`/DOM imports — so
 * this is directly vitest-testable and typechecks under the webview tsconfig too.
 */
import type { Problem } from "./types";
import type { GhostBlame } from "../protocol/messages";

export interface FileDiagnosticEntry {
  /** 0-based line number, straight from `problem.locations`. */
  line: number;
  message: string;
}

/** Appended to a `broken-down-revision` problem's summary — points the user at the one UI action
 * that actually fixes it (there's no CLI for repointing a down_revision; see core/repoint.ts). */
const BROKEN_HINT = " — drag the ghost node onto a real revision in the Migration Graph to repair";

/**
 * Task B1: blame-specific suffix for a `broken-down-revision` problem, inserted between the base
 * summary and `BROKEN_HINT` — context (what happened to the missing revision) before action (what
 * to do about it). Absent/`null` blame (pending search, or searched-and-not-found) yields "" so the
 * message is byte-identical to before this task, for every ghost blame hasn't resolved for yet.
 */
function blameSuffix(missingId: string, ghostBlame?: Record<string, GhostBlame | null>): string {
  const blame = ghostBlame?.[missingId];
  if (!blame) return "";
  if (blame.kind === "deleted-here") return ` — deleted in ${blame.shortCommit} by ${blame.author}`;
  return ` — never in this branch's history (introduced in ${blame.introducedShortCommit})`;
}

/**
 * Groups every `problem.locations` entry by file, preserving problem order (and, within a problem,
 * location order). Multiple problems — or multiple locations of the SAME problem, e.g. a
 * duplicate-id's two files — can share a file, so callers must accumulate all of a file's entries
 * before publishing rather than overwriting per-problem. `broken-down-revision` messages get
 * `blameSuffix` (Task B1: when blame for `revisionIds[1]`, the missing id, is known) then
 * `BROKEN_HINT` appended; every other kind uses `problem.summary` verbatim. `ghostBlame` is
 * optional and backward compatible: omitting it (or a pending/not-found entry) reproduces the
 * exact pre-Task-B1 message.
 */
export function buildFileDiagnostics(
  problems: Problem[],
  ghostBlame?: Record<string, GhostBlame | null>,
): Map<string, FileDiagnosticEntry[]> {
  const byFile = new Map<string, FileDiagnosticEntry[]>();
  for (const problem of problems) {
    const message =
      problem.kind === "broken-down-revision"
        ? `${problem.summary}${blameSuffix(problem.revisionIds[1], ghostBlame)}${BROKEN_HINT}`
        : problem.summary;
    for (const location of problem.locations) {
      const entry: FileDiagnosticEntry = { line: location.line, message };
      const existing = byFile.get(location.filePath);
      if (existing) existing.push(entry);
      else byFile.set(location.filePath, [entry]);
    }
  }
  return byFile;
}
