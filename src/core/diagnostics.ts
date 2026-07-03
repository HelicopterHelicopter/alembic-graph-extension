/**
 * Pure diagnostic-building logic: turns graph `Problem`s (core/types.ts) into a per-file list of
 * {line, message} entries, ready for a thin vscode.Diagnostic wrapper (src/services/diagnostics.ts)
 * to construct. Same purity rule as the rest of core/*.ts — no `vscode`/`node`/DOM imports — so
 * this is directly vitest-testable and typechecks under the webview tsconfig too.
 */
import type { Problem } from "./types";

export interface FileDiagnosticEntry {
  /** 0-based line number, straight from `problem.locations`. */
  line: number;
  message: string;
}

/** Appended to a `broken-down-revision` problem's summary — points the user at the one UI action
 * that actually fixes it (there's no CLI for repointing a down_revision; see core/repoint.ts). */
const BROKEN_HINT = " — drag the ghost node onto a real revision in the Migration Graph to repair";

/**
 * Groups every `problem.locations` entry by file, preserving problem order (and, within a problem,
 * location order). Multiple problems — or multiple locations of the SAME problem, e.g. a
 * duplicate-id's two files — can share a file, so callers must accumulate all of a file's entries
 * before publishing rather than overwriting per-problem. `broken-down-revision` messages get
 * `BROKEN_HINT` appended; every other kind uses `problem.summary` verbatim.
 */
export function buildFileDiagnostics(problems: Problem[]): Map<string, FileDiagnosticEntry[]> {
  const byFile = new Map<string, FileDiagnosticEntry[]>();
  for (const problem of problems) {
    const message = problem.kind === "broken-down-revision" ? `${problem.summary}${BROKEN_HINT}` : problem.summary;
    for (const location of problem.locations) {
      const entry: FileDiagnosticEntry = { line: location.line, message };
      const existing = byFile.get(location.filePath);
      if (existing) existing.push(entry);
      else byFile.set(location.filePath, [entry]);
    }
  }
  return byFile;
}
