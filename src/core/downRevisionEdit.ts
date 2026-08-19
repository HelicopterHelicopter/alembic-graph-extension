/**
 * Pure text surgery that rewrites a migration file's ENTIRE `down_revision` value to an arbitrary
 * new parent list. Where `core/repoint.ts`'s `computeRepointedSource` swaps one member for another
 * (arity fixed), this primitive changes arity freely — `None` ↔ scalar ↔ tuple — which is what
 * freeform topology editing (move/splice/insert/remove-link) needs.
 *
 * Same purity rule as parser.ts/repoint.ts: no `node`/`vscode`/DOM APIs, so this file typechecks
 * under both the extension-host tsconfig and the webview tsconfig.
 *
 * Byte-identical rule: only the `down_revision` assignment's line range and (best-effort) the FIRST
 * `Revises:` line ABOVE it change; every other byte of the caller's `src` — BOM, CRLF/CR/LF mix,
 * a missing final newline — survives untouched, because the reconstruction slices the caller's own
 * raw text via `splitRawLines` rather than round-tripping through parser.ts's normalizing split.
 *
 * Deliberate normalization inside the replaced range: the whole assignment (however many lines it
 * spanned) collapses to ONE line, so a Black-style multi-line tuple loses its layout and any
 * comments on its CONTINUATION lines are dropped. Only the comment on the assignment's first line
 * is carried over (re-attached with a two-space separator). This keeps the rendered value canonical
 * — reformatting is the caller's/Black's job, not this module's.
 */
import { commentStartIndex, locateDownRevisionAssignment, matchModuleAssignment, parseRevisionSource } from "./parser";
import { QUOTED_RE, computeCommentRanges, isInRange, splitEol, splitRawLines } from "./repoint";

export type DownRevisionsRewriteResult = { ok: true; newSrc: string } | { ok: false; reason: string };

/** The identity half of a migration file's header: which revision it declares and which parents it
 * currently claims. `downRevisions` is order-sensitive — a `down_revision` tuple's order is
 * meaningful, so a reorder is a real change. */
export interface RevisionHeader {
  revisionId: string;
  downRevisions: string[];
}

/**
 * Reads a migration file's `revision` / `down_revision` pair out of full source text, or null when
 * the text declares no `revision` at all (an env.py, a truncated buffer, a file mid-edit).
 * A missing `down_revision` and an explicit `None` both read as `[]`, matching how the scanner
 * treats a base revision.
 *
 * A deliberately thin delegation to `parseRevisionSource` rather than a second, narrower scanner:
 * `MigrationService.doRefresh` builds `cachedGraph` from that exact function, so anything comparing
 * a live buffer against a planned edit's expectations (services/repoint.ts's `applyDownRevisionEdits`)
 * has to parse it the same way or the comparison is not apples-to-apples — a second parser that
 * disagreed on, say, a Black-wrapped tuple would reject valid edits. The wrapper exists only to
 * drop `parseRevisionSource`'s file-oriented fields (message, dates, line numbers) and its required
 * `filePath` argument, which a caller holding just a buffer has no use for.
 */
export function readRevisionHeader(src: string): RevisionHeader | null {
  // `filePath` only ever comes back out on the returned object, which is discarded here.
  const parsed = parseRevisionSource(src, "");
  if (parsed === null) return null;
  return { revisionId: parsed.revision, downRevisions: parsed.downRevisions };
}

const BOM = "\ufeff";

/** Quote used when neither the old value nor the `revision` assignment offers one to copy. */
const DEFAULT_QUOTE = "'";

/**
 * Returns the quote character of the first quoted string in `lines` (concatenated) that does NOT
 * fall inside a comment, or null if there is none. Comment filtering matters because a note like
 * `down_revision = (  # replaces "zzz"` would otherwise dictate the output quote style.
 */
function firstNonCommentQuote(lines: string[]): string | null {
  const raw = lines.join("");
  const ranges = computeCommentRanges(lines);
  for (const m of raw.matchAll(QUOTED_RE)) {
    const idx = m.index ?? raw.indexOf(m[0]);
    if (!isInRange(idx, ranges)) return m[1];
  }
  return null;
}

/** Strips the leading BOM from line 0's content; other lines are returned unchanged. */
function stripLineBom(content: string, lineIndex: number): string {
  return lineIndex === 0 && content.startsWith(BOM) ? content.slice(BOM.length) : content;
}

/**
 * Picks the quote character for the rendered members: the old value's own style if it had any
 * quoted member, else the style of the module-level `revision` assignment (the file's other,
 * always-present revision id literal), else `'`. The `revision` fallback is what makes a
 * `None` → scalar/tuple rewrite match the file's prevailing style.
 */
function chooseQuote(rawLines: string[], blockLines: string[]): string {
  const fromOldValue = firstNonCommentQuote(blockLines);
  if (fromOldValue !== null) return fromOldValue;

  for (let i = 0; i < rawLines.length; i++) {
    const content = stripLineBom(splitEol(rawLines[i])[0], i);
    const rhs = matchModuleAssignment(content, "revision");
    if (rhs === null) continue;
    const fromRevision = firstNonCommentQuote([rhs]);
    if (fromRevision !== null) return fromRevision;
  }
  return DEFAULT_QUOTE;
}

/** `[]` → `None`, `[x]` → `'x'`, `[x, y, …]` → `('x', 'y')` (single line, no trailing comma). */
function renderValue(ids: string[], quote: string): string {
  if (ids.length === 0) return "None";
  const quoted = ids.map((id) => `${quote}${id}${quote}`);
  return quoted.length === 1 ? quoted[0] : `(${quoted.join(", ")})`;
}

/**
 * Best-effort rewrite of the module docstring's `Revises:` line to exactly `newIds`: the FIRST
 * such line ABOVE `beforeLine` wins (later ones are prose, e.g. a hand-written note, and are left
 * alone), its prefix and its own line ending are preserved, and an empty `newIds` leaves a bare
 * `Revises:` with no trailing whitespace. Returns `src` unchanged when no line qualifies
 * (docstring absent or non-standard); per the spec this patch must never fail the operation.
 *
 * `beforeLine` is the `down_revision` assignment's own first line, and that bound is what keeps a
 * cosmetic docstring patch from rewriting executable migration code. In every standard alembic
 * layout the module docstring precedes the module-level assignments and the `upgrade()` /
 * `downgrade()` bodies follow them — and those bodies routinely contain triple-quoted SQL, where a
 * line like `Revises: <id>` (a copied ticket note, a comment) can easily appear. Unbounded, a file
 * whose docstring has NO `Revises:` line at all would let that SQL line become the first match and
 * be silently rewritten. Unlike `core/repoint.ts`'s token-swapping counterpart, this rewrite has no
 * "must mention the id being replaced" precondition to fall back on, so the bound is the only
 * thing standing between a decoy line and a corrupted migration.
 *
 * Accepted limitation: a module-level string constant ABOVE the assignment that happens to contain
 * such a line is still in bounds and can still be hit. Ruling that out would need real
 * docstring-span parsing, which isn't warranted for a best-effort cosmetic patch — the layout it
 * would protect against does not occur in alembic-generated files.
 */
function patchRevisesLineFull(src: string, newIds: string[], beforeLine: number): string {
  const rawLines = splitRawLines(src);
  const limit = Math.min(beforeLine, rawLines.length);

  for (let i = 0; i < limit; i++) {
    const [content, eol] = splitEol(rawLines[i]);
    const m = /^(\s*Revises:\s*)(.*)$/.exec(content);
    if (!m) continue;
    const prefix = m[1];
    const newContent = newIds.length === 0 ? prefix.trimEnd() : prefix + newIds.join(", ");
    rawLines[i] = newContent + eol;
    return rawLines.join("");
  }
  return src;
}

/**
 * Replaces the module-level `down_revision` value with `newIds`, collapsing the assignment to a
 * single line while preserving its left-hand side (including annotated forms such as
 * `down_revision: Union[str, Sequence[str], None] =`) byte-for-byte, its quote style, its
 * first-line trailing comment, and its last consumed line's line ending. Also best-effort patches
 * the docstring's `Revises:` line (see `patchRevisesLineFull`).
 *
 * Callers guarantee `newIds` is already deduplicated and that each id is a plain revision id (no
 * quotes or backslashes); ids are rendered verbatim.
 */
export function computeDownRevisionsRewrite(src: string, newIds: string[]): DownRevisionsRewriteResult {
  const loc = locateDownRevisionAssignment(src);
  if (loc === null) {
    return { ok: false, reason: "no down_revision assignment found" };
  }

  const rawLines = splitRawLines(src);
  const { startLine, endLine } = loc;
  const blockLines = rawLines.slice(startLine, endLine + 1);

  // `locateDownRevisionAssignment` matches against BOM-stripped text, so mirror that here and put
  // the BOM back on the left-hand side (only reachable for a file whose very first line is the
  // assignment).
  const rawContent = splitEol(blockLines[0])[0];
  const content = stripLineBom(rawContent, startLine);
  const bom = rawContent.slice(0, rawContent.length - content.length);

  const rhs = matchModuleAssignment(content, "down_revision");
  if (rhs === null) {
    // Defensive: `locateDownRevisionAssignment` found this line with the same matcher.
    return { ok: false, reason: "no down_revision assignment found" };
  }

  const lhs = bom + content.slice(0, content.length - rhs.length);
  const commentIdx = commentStartIndex(content);
  const comment = commentIdx < content.length ? `  ${content.slice(commentIdx).trimEnd()}` : "";
  const eol = splitEol(rawLines[endLine])[1];
  const newLine = `${lhs} ${renderValue(newIds, chooseQuote(rawLines, blockLines))}${comment}${eol}`;

  const newSrc = rawLines.slice(0, startLine).join("") + newLine + rawLines.slice(endLine + 1).join("");

  // `startLine` indexes `newSrc` just as validly as it indexes `src`: the block collapse only ever
  // rewrites lines at or after `startLine`, leaving every line above it — the docstring — untouched
  // and at its original index.
  return { ok: true, newSrc: patchRevisesLineFull(newSrc, newIds, startLine) };
}
