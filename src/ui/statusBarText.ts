/**
 * Pure text formatting for statusBar.ts, split out (same pattern as actionHelpers.ts vs
 * actions.ts) because statusBar.ts imports `vscode` at module scope and can't load under vitest.
 */

/**
 * Status-bar "current revision" label — text AND tooltip from one function so the singular/plural
 * branch can never drift between the two. Multi-head databases legitimately have SEVERAL current
 * revisions (one per applied branch head): the first shows as a 10-char prefix, the rest as an
 * explicit `+N`, and the tooltip enumerates every full id. Null when the current set is
 * empty/unknown (the status bar item hides).
 */
export function currentRevisionLabel(currentIds: string[]): { text: string; tooltip: string } | null {
  if (currentIds.length === 0) return null;
  const first = `current: ${currentIds[0].substring(0, 10)}`;
  if (currentIds.length === 1) {
    return { text: first, tooltip: "Current database revision" };
  }
  return {
    text: `${first} +${currentIds.length - 1}`,
    tooltip: `${currentIds.length} current database revisions:\n${currentIds.join("\n")}`,
  };
}
