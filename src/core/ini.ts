/**
 * Minimal INI reader for `alembic.ini`: extracts `script_location` from the `[alembic]`
 * section only.
 *
 * Pure string-in/data-out module: no `node`, `vscode`, or DOM APIs, so it typechecks under
 * both the extension-host tsconfig and the webview tsconfig (same rule as parser.ts).
 * `%(here)s` interpolation and relative-path resolution are deliberately NOT done here — the
 * raw value is returned as-is; discovery.ts resolves it against the ini file's directory.
 */

/** Matches a full-line section header, e.g. `[alembic]`. Capture group is the section name. */
const SECTION_RE = /^\[([^\]]*)\]$/;

/** Matches a `key = value` / `key: value` line. Alembic keys are case-sensitive. */
const KEY_RE = /^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/;

/** Extract `script_location` from the `[alembic]` section of `iniText`. Null if absent. */
export function parseScriptLocation(iniText: string): string | null {
  const lines = iniText.split(/\r\n|\r|\n/);
  let currentSection: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (currentSection !== "alembic") continue;

    const keyMatch = KEY_RE.exec(line);
    if (!keyMatch) continue;

    if (keyMatch[1] !== "script_location") continue;

    return keyMatch[2].trim();
  }

  return null;
}
