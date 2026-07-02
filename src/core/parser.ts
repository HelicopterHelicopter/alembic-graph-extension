/**
 * Static parser for Alembic `versions/*.py` source text.
 *
 * Pure string-in/data-out module: no `node`, `vscode`, or DOM APIs. This file
 * is typechecked under both the extension-host tsconfig and the webview
 * tsconfig, so it must stay free of environment-specific globals.
 */
import type { ParsedRevision } from "./types";

/** Splits source into lines, normalizing CRLF/CR/LF so indices match editor line numbers. */
function splitLines(src: string): string[] {
  return src.split(/\r\n|\r|\n/);
}

/** Strips a leading UTF-8 BOM, if present, without shifting any line indices. */
function stripBOM(src: string): string {
  return src.length > 0 && src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
}

/** Truncates a line at the first `#` that isn't inside a quoted string. */
function stripTrailingComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === "#" && !inSingle && !inDouble) {
      return s.slice(0, i);
    }
  }
  return s;
}

/**
 * Matches a module-level (column-0) `name = ...` or `name: <ann> = ...` assignment on one
 * line. Returns the raw right-hand side (everything after the first `=`), or null if this
 * line isn't such an assignment for `name`.
 */
function matchModuleAssignment(line: string, name: string): string | null {
  if (!line.startsWith(name)) return null;
  const after = line.slice(name.length);
  // Reject longer identifiers that merely start with `name` (e.g. "revision_id").
  if (after.length > 0 && /[A-Za-z0-9_]/.test(after[0])) return null;
  const eqIdx = after.indexOf("=");
  if (eqIdx === -1) return null;
  if (after[eqIdx + 1] === "=") return null; // defensive: not "=="
  return after.slice(eqIdx + 1);
}

/** Extracts the first single/double-quoted string literal from a value expression. */
function extractQuotedString(rhs: string): string | null {
  const stripped = stripTrailingComment(rhs).trim();
  const m = stripped.match(/^['"]([^'"]*)['"]/);
  return m ? m[1] : null;
}

/**
 * Parses the down_revision / branch_labels value grammar: `None` -> [], a quoted string ->
 * single-element array, or a tuple/list of quoted strings -> array in order.
 */
function extractValueList(rhs: string): string[] {
  const stripped = stripTrailingComment(rhs).trim();
  if (stripped === "" || stripped === "None") return [];
  const first = stripped[0];
  if (first === "'" || first === '"') {
    const value = extractQuotedString(stripped);
    return value !== null ? [value] : [];
  }
  if (first === "(" || first === "[") {
    const values: string[] = [];
    const re = /['"]([^'"]*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      values.push(m[1]);
    }
    return values;
  }
  return [];
}

/**
 * Finds the module docstring (the first `"""`/`'''` block at file start, tolerating leading
 * whitespace/comment lines) and extracts its first non-empty line and a `Create Date:` value.
 */
function extractDocstring(src: string): { message: string; createDate: string | null } {
  const headerRe = /^(?:[ \t]*(?:#[^\r\n]*)?\r?\n)*[ \t]*("""|''')/;
  const m = headerRe.exec(src);
  if (!m) return { message: "", createDate: null };

  const quote = m[1];
  const contentStart = m[0].length;
  const closeIdx = src.indexOf(quote, contentStart);
  const content = closeIdx === -1 ? src.slice(contentStart) : src.slice(contentStart, closeIdx);
  const lines = splitLines(content);

  let message = "";
  for (const line of lines) {
    if (line.trim() !== "") {
      message = line.trim();
      break;
    }
  }

  let createDate: string | null = null;
  for (const line of lines) {
    const cm = line.trim().match(/^Create Date:\s*(.*)$/);
    if (cm) {
      createDate = cm[1].trim();
      break;
    }
  }

  return { message, createDate };
}

export function parseRevisionSource(src: string, filePath: string): ParsedRevision | null {
  const text = stripBOM(src);
  const lines = splitLines(text);

  let revisionMatch: { value: string; line: number } | null = null;
  let downRevisionMatch: { values: string[]; line: number } | null = null;
  let branchLabelsValues: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (revisionMatch === null) {
      const rhs = matchModuleAssignment(line, "revision");
      if (rhs !== null) {
        const value = extractQuotedString(rhs);
        if (value !== null) {
          revisionMatch = { value, line: i };
        }
      }
    }

    if (downRevisionMatch === null) {
      const rhs = matchModuleAssignment(line, "down_revision");
      if (rhs !== null) {
        downRevisionMatch = { values: extractValueList(rhs), line: i };
      }
    }

    if (branchLabelsValues === null) {
      const rhs = matchModuleAssignment(line, "branch_labels");
      if (rhs !== null) {
        branchLabelsValues = extractValueList(rhs);
      }
    }
  }

  if (revisionMatch === null) return null;

  const { message, createDate } = extractDocstring(text);

  return {
    revision: revisionMatch.value,
    downRevisions: downRevisionMatch ? downRevisionMatch.values : [],
    branchLabels: branchLabelsValues ?? [],
    message,
    createDate,
    filePath,
    revisionLine: revisionMatch.line,
    downRevisionLine: downRevisionMatch ? downRevisionMatch.line : null,
  };
}

export function extractFunctionBody(src: string, fn: "upgrade" | "downgrade"): string | null {
  const text = stripBOM(src);
  const lines = splitLines(text);
  const defRe = new RegExp(`^def\\s+${fn}\\s*\\(\\s*\\)\\s*(?:->\\s*[^:]*)?:\\s*$`);

  let defLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (defRe.test(lines[i])) {
      defLineIndex = i;
      break;
    }
  }
  if (defLineIndex === -1) return null;

  let endIndex = lines.length;
  for (let i = defLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && /^[^ \t]/.test(line)) {
      endIndex = i;
      break;
    }
  }

  const bodyLines = lines.slice(defLineIndex + 1, endIndex);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
    bodyLines.pop();
  }
  if (bodyLines.length === 0) return "";

  let minIndent = Infinity;
  for (const line of bodyLines) {
    if (line.trim() === "") continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!isFinite(minIndent)) minIndent = 0;

  const dedented = bodyLines.map((line) => (line.length >= minIndent ? line.slice(minIndent) : ""));
  return dedented.join("\n");
}
