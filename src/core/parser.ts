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

/**
 * Returns the index of the first `#` in `s` that isn't inside a single/double-quoted string, or
 * `s.length` if there is none. The shared quote-aware state machine backing both
 * `stripTrailingComment` (below) and `core/repoint.ts`'s comment-aware quote scanning — exported
 * so repoint.ts can mask out comment ranges without duplicating this logic.
 */
export function commentStartIndex(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === "#" && !inSingle && !inDouble) {
      return i;
    }
  }
  return s.length;
}

/** Truncates a line at the first `#` that isn't inside a quoted string. */
function stripTrailingComment(s: string): string {
  return s.slice(0, commentStartIndex(s));
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
  // Assumes revision ids never contain embedded/escaped quotes (real Alembic ids are
  // hex/slug strings), so a naive non-greedy quote match is sufficient here.
  const m = stripped.match(/^['"]([^'"]*)['"]/);
  return m ? m[1] : null;
}

/**
 * Parses the down_revision / branch_labels value grammar: `None` -> [], a quoted string ->
 * single-element array, or a tuple/list of quoted strings -> array in order. `rhs` may span
 * multiple lines already joined by `resolveValueListRhs` for bracket-spanning tuples/lists.
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
    // Same simplifying assumption as extractQuotedString: no embedded/escaped quotes.
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
 * Computes the net (`(`/`[` minus `)`/`]`) bracket depth of a string, ignoring bracket
 * characters that appear inside quoted segments.
 */
function netBracketDepth(s: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
    }
  }
  return depth;
}

/**
 * Resolves a `down_revision`/`branch_labels` right-hand side that may span multiple lines,
 * e.g. a Black-formatted merge revision:
 * ```
 * down_revision = (
 *     "18c9d9663f5b",
 *     "07b8c8552e4a",
 * )
 * ```
 * `rhs` is the text after `=` on the assignment's own line (`lines[startIndex]`). Each
 * candidate line is stripped of trailing comments (quote-aware, via `stripTrailingComment`)
 * before being folded into the running bracket-depth count, so a comment containing `(`/`)`
 * never perturbs the balance. Accumulation stops once depth returns to 0 (single-line values,
 * which never go positive, are returned unchanged) or at EOF. The joined text is handed to
 * `extractValueList` exactly as a single-line RHS would be.
 */
function resolveValueListRhs(lines: string[], startIndex: number, rhs: string): string {
  let combined = stripTrailingComment(rhs);
  let depth = netBracketDepth(combined);
  let i = startIndex + 1;
  while (depth > 0 && i < lines.length) {
    const strippedLine = stripTrailingComment(lines[i]);
    combined += "\n" + strippedLine;
    depth += netBracketDepth(strippedLine);
    i++;
  }
  return combined;
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

export interface DownRevisionLocation {
  /** 0-based index of the line containing `down_revision = ...` (or its annotated form). Line
   * indices match a CRLF/CR/LF-normalizing split of the (BOM-stripped) source — callers that need
   * byte-identical reconstruction (core/repoint.ts) must slice their OWN raw text by these
   * indices, preserving each line's original line-ending characters themselves. */
  startLine: number;
  /** 0-based index of the LAST line the (possibly multi-line, bracket-continued) value spans,
   * inclusive; equals `startLine` for a single-line value. */
  endLine: number;
}

/**
 * Locates the module-level `down_revision` assignment's line range, using the exact same
 * annotated-form / bracket-continuation detection `parseRevisionSource` uses for its own
 * `downRevisionMatch`. Exported so `core/repoint.ts` can text-surgically edit the value without
 * duplicating this detection logic. Returns null if no down_revision assignment is found (mirrors
 * `parseRevisionSource`'s own `downRevisionMatch === null` case).
 */
export function locateDownRevisionAssignment(src: string): DownRevisionLocation | null {
  const text = stripBOM(src);
  const lines = splitLines(text);

  for (let i = 0; i < lines.length; i++) {
    const rhs = matchModuleAssignment(lines[i], "down_revision");
    if (rhs === null) continue;
    const resolved = resolveValueListRhs(lines, i, rhs);
    const spanLines = resolved.split("\n").length; // resolveValueListRhs joins consumed lines with "\n"
    return { startLine: i, endLine: i + spanLines - 1 };
  }
  return null;
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
        const resolvedRhs = resolveValueListRhs(lines, i, rhs);
        downRevisionMatch = { values: extractValueList(resolvedRhs), line: i };
      }
    }

    if (branchLabelsValues === null) {
      const rhs = matchModuleAssignment(line, "branch_labels");
      if (rhs !== null) {
        const resolvedRhs = resolveValueListRhs(lines, i, rhs);
        branchLabelsValues = extractValueList(resolvedRhs);
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
