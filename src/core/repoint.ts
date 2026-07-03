/**
 * Pure text surgery for repairing a broken `down_revision` link: rewrites the ONE quoted
 * occurrence of a missing revision id to point at a real target instead, byte-identical
 * everywhere else in the file. Alembic has no CLI for this (unlike `merge`) — this is the whole
 * mechanism.
 *
 * Same purity rule as parser.ts/graph.ts: no `node`/`vscode`/DOM APIs, so this file typechecks
 * under both the extension-host tsconfig and the webview tsconfig.
 *
 * Byte-identical rule: this module NEVER round-trips through `parser.ts`'s line-splitting (which
 * discards each line's original `\r\n`/`\r`/`\n` characters) for RECONSTRUCTION — only for
 * *locating* the down_revision assignment's line range (`locateDownRevisionAssignment`). The
 * actual text substitution operates on `splitRawLines`' line-ending-preserving slices of the
 * caller's own `src`, so joining them back always reproduces the original string exactly except
 * for the one quoted span (and, separately, the one `Revises:` token) that's deliberately changed.
 */
import { locateDownRevisionAssignment } from "./parser";

export type RepointResult = { ok: true; newSrc: string } | { ok: false; reason: string };

/** Matches a single/double-quoted string literal. Same simplifying assumption parser.ts's own
 * `extractQuotedString`/`extractValueList` make: revision ids never contain embedded/escaped
 * quotes, so a naive non-greedy quote match is sufficient. */
const QUOTED_RE = /(['"])([^'"]*)\1/g;

/** 8-char id prefix used in error messages, matching the truncation convention used elsewhere in
 * the codebase (e.g. src/ui/actions.ts's merge input-box default value). */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits `src` into lines that each RETAIN their own original line-ending characters (the last
 * line has none if the file doesn't end in a newline). Index-aligned with `parser.ts`'s
 * `splitLines` (plain, delimiter-discarding split) — a BOM, if present, only changes line 0's
 * leading character, never the number of lines — so a `startLine`/`endLine` pair from
 * `locateDownRevisionAssignment` indexes correctly into this array too. `lines.join("")`
 * reproduces `src` exactly.
 */
function splitRawLines(src: string): string[] {
  const parts = src.split(/(\r\n|\r|\n)/);
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const eol = i + 1 < parts.length ? parts[i + 1] : "";
    lines.push(parts[i] + eol);
  }
  return lines;
}

/** Strips a line's own trailing line-ending characters, returning `[content, eol]`. */
function splitEol(line: string): [string, string] {
  const m = /(\r\n|\r|\n)$/.exec(line);
  return m ? [line.slice(0, line.length - m[0].length), m[0]] : [line, ""];
}

/**
 * Best-effort patch of the module docstring's `Revises:` line (comma-separated lists supported):
 * replaces the standalone `missingId` token with `targetId`, preserving every other character on
 * the line (and every other line in the file) exactly. A no-op — returning `src` unchanged — when
 * no `Revises:` line is found at all (docstring absent) or it doesn't happen to mention
 * `missingId`; per the spec this patch must never fail the overall operation.
 */
function patchRevisesLine(src: string, missingId: string, targetId: string): string {
  const rawLines = splitRawLines(src);
  const tokenRe = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(missingId)}(?![A-Za-z0-9_])`);

  for (let i = 0; i < rawLines.length; i++) {
    const [content, eol] = splitEol(rawLines[i]);
    const m = /^(\s*Revises:\s*)(.*)$/.exec(content);
    if (!m) continue;
    const [, prefix, rest] = m;
    if (!tokenRe.test(rest)) return src; // a Revises: line exists but doesn't mention missingId
    const newRest = rest.replace(tokenRe, (_whole, boundary: string) => `${boundary}${targetId}`);
    rawLines[i] = prefix + newRest + eol;
    return rawLines.join("");
  }
  return src; // no Revises: line at all — docstring absent (or non-standard); leave untouched
}

/**
 * Replaces the quoted occurrence of `missingId` in the module-level `down_revision` value with
 * `targetId`, preserving quote style and all other formatting (comments, multi-line
 * bracket-continued tuples/lists, annotated forms) byte-for-byte. Also best-effort patches the
 * docstring's `Revises:` line token, if present (see `patchRevisesLine`).
 */
export function computeRepointedSource(src: string, missingId: string, targetId: string): RepointResult {
  const loc = locateDownRevisionAssignment(src);
  if (loc === null) {
    return { ok: false, reason: `down_revision does not reference ${shortId(missingId)}` };
  }

  const rawLines = splitRawLines(src);
  const { startLine, endLine } = loc;
  const blockRaw = rawLines.slice(startLine, endLine + 1).join("");

  const matches = [...blockRaw.matchAll(QUOTED_RE)];
  const missingMatch = matches.find((m) => m[2] === missingId);
  if (!missingMatch) {
    return { ok: false, reason: `down_revision does not reference ${shortId(missingId)}` };
  }
  const alreadyHasTarget = matches.some((m) => m !== missingMatch && m[2] === targetId);
  if (alreadyHasTarget) {
    return { ok: false, reason: `already revises ${shortId(targetId)}` };
  }

  const quote = missingMatch[1];
  const matchStart = missingMatch.index ?? blockRaw.indexOf(missingMatch[0]);
  const matchEnd = matchStart + missingMatch[0].length;
  const newBlock = blockRaw.slice(0, matchStart) + quote + targetId + quote + blockRaw.slice(matchEnd);

  const newSrc = rawLines.slice(0, startLine).join("") + newBlock + rawLines.slice(endLine + 1).join("");

  return { ok: true, newSrc: patchRevisesLine(newSrc, missingId, targetId) };
}
