/**
 * Pure, DOM-free math for Task 19's canvas UX: zoom clamp/anchor/fit, search match predicate,
 * ancestor-set walk (hover highlight), and keyboard neighbor-finding. Mirrors metrics.ts's split
 * (pure math here, DOM wiring in zoom/search/hover/keyboardNav.ts's `attach*` functions) so the
 * fiddly parts are covered by vitest instead of only Playwright.
 *
 * Task B2 adds `ghostBlameLineText` (ghost-card blame line + button + tooltip) to this same
 * pure-math module rather than a new file, per the plan's "uxMath.ts-style module" option — it's a
 * type-only import (`GhostBlame` from protocol/messages.ts, itself DOM/vscode-free), so this file
 * stays exactly as dependency-free as every other function here.
 */
import type { GhostBlame } from "../../protocol/messages";

// ---------- zoom ----------

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.5;
export const ZOOM_DEFAULT = 1;
export const ZOOM_STEP = 0.1;

/** Clamps to the toolbar's supported zoom range [0.5, 1.5]. */
export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** One 0.1 zoom step in `direction` (+1 in, -1 out), clamped. Rounded to 2dp to avoid float drift
 * (e.g. 0.1 + 0.2 accumulating error over repeated clicks/wheel ticks). */
export function stepZoom(current: number, direction: 1 | -1): number {
  const stepped = current + direction * ZOOM_STEP;
  return clampZoom(Math.round(stepped * 100) / 100);
}

export interface ScrollPoint {
  scrollLeft: number;
  scrollTop: number;
}

/** Viewport-relative pointer offset (unscrolled) the zoom is anchored at — e.g. the cursor for a
 * ctrl/cmd+wheel zoom, or the viewport center for a toolbar button click. */
export interface ZoomAnchor {
  offsetX: number;
  offsetY: number;
}

/**
 * Computes the scroll position that keeps the content point under `anchor` fixed on screen while
 * zooming from `oldZoom` to `newZoom`. Content-space point under the anchor before zooming:
 * `(scroll + offset) / oldZoom`; solving for the new scroll that puts the same content point back
 * under the same screen offset at `newZoom` gives `contentPoint * newZoom - offset`. Clamped to
 * >= 0 (upper-bound clamping against the scaled canvas size is the DOM caller's job — the browser
 * clamps scrollLeft/Top to the real scrollable extent on assignment anyway).
 */
export function zoomAnchorScroll(
  scroll: ScrollPoint,
  anchor: ZoomAnchor,
  oldZoom: number,
  newZoom: number,
): ScrollPoint {
  const contentX = (scroll.scrollLeft + anchor.offsetX) / oldZoom;
  const contentY = (scroll.scrollTop + anchor.offsetY) / oldZoom;
  return {
    scrollLeft: Math.max(0, contentX * newZoom - anchor.offsetX),
    scrollTop: Math.max(0, contentY * newZoom - anchor.offsetY),
  };
}

export interface BoxSize {
  w: number;
  h: number;
}

/** Zoom (clamped to [0.5, 1.5]) that fits the whole (unscaled) canvas inside the viewport. Falls
 * back to 1.0 for a degenerate (zero/negative) canvas or viewport size — can't meaningfully fit,
 * and a fallback keeps callers from having to special-case NaN/Infinity. */
export function fitZoom(canvas: BoxSize, viewport: BoxSize): number {
  if (canvas.w <= 0 || canvas.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return ZOOM_DEFAULT;
  return clampZoom(Math.min(viewport.w / canvas.w, viewport.h / canvas.h));
}

/** Scroll position that centers the (already-scaled) canvas within the viewport at `zoom`. */
export function fitScroll(canvas: BoxSize, viewport: BoxSize, zoom: number): ScrollPoint {
  const scaledW = canvas.w * zoom;
  const scaledH = canvas.h * zoom;
  return {
    scrollLeft: Math.max(0, (scaledW - viewport.w) / 2),
    scrollTop: Math.max(0, (scaledH - viewport.h) / 2),
  };
}

// ---------- search ----------

export interface SearchableNode {
  hash: string;
  message: string;
  author: string | null;
  branchLabel: string | null;
}

/** Case-insensitive match: hash PREFIX, or substring of message/author/branchLabel. An empty (or
 * all-whitespace) query always matches — callers that mean "search inactive" for an empty query
 * (dimming, matches list) should check that themselves rather than relying on this returning
 * false. */
export function matchesQuery(query: string, node: SearchableNode): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (node.hash.toLowerCase().startsWith(q)) return true;
  if (node.message.toLowerCase().includes(q)) return true;
  if (node.author !== null && node.author.toLowerCase().includes(q)) return true;
  if (node.branchLabel !== null && node.branchLabel.toLowerCase().includes(q)) return true;
  return false;
}

// ---------- search cycle ----------

/**
 * Cycle-index math for Enter/Shift+Enter over `count` search matches (search.ts). `index` is the
 * last cycle position, or -1 as the sentinel for "no cycle yet since the query last changed/was
 * set" (search.ts starts fresh at -1 on every keystroke).
 *
 * Both the first-Enter and first-Shift+Enter cases are handled explicitly rather than falling
 * through to the general wrap formula: naively computing `(index +/- 1 + count) % count` with
 * `index = -1` only happens to give the right answer (0) for the forward direction — for backward
 * it gives `count - 2`, landing one match short of the actual last match. Modeling `-1` as "no
 * current position" (not "the position before 0") for both directions keeps the two symmetric: the
 * very first Enter always shows the FIRST match, the very first Shift+Enter always shows the LAST.
 */
export function nextMatchIndex(index: number, count: number): number {
  if (index === -1) return 0;
  return (index + 1) % count;
}

/** Backward counterpart of {@link nextMatchIndex} — see its doc comment for the `-1` sentinel
 * handling that fixes the "lands one short" bug. */
export function prevMatchIndex(index: number, count: number): number {
  if (index === -1) return count - 1;
  return (index - 1 + count) % count;
}

// ---------- ancestry ----------

export interface AncestorNode {
  id: string;
  downRevisions: string[];
}

/**
 * Walks `downRevisions` transitively from `startId`, returning the hovered node plus every
 * ancestor reached (including ids with no layout node of their own, e.g. a ghost — they're added
 * to the set but simply have nothing further to walk from). Cycle-safe: a node is only ever
 * pushed onto the work stack once (guarded by the `result` set membership check), so a corrupt
 * down_revision graph with a cycle terminates instead of looping forever.
 */
export function computeAncestorSet(startId: string, nodes: AncestorNode[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Set<string>([startId]);
  const stack = [startId];

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    const node = byId.get(id);
    if (!node) continue;
    for (const parentId of node.downRevisions) {
      if (result.has(parentId)) continue;
      result.add(parentId);
      stack.push(parentId);
    }
  }

  return result;
}

// ---------- keyboard navigation ----------

export interface NavNode {
  id: string;
  lane: number;
  row: number;
}

export type NavOrder = "newest-top" | "newest-bottom";
/** Mirrors `UiPrefs["axis"]` (protocol/messages.ts) — redeclared locally rather than imported so
 * this module stays dependency-free, same rationale as `NavOrder` above. */
export type NavAxis = "vertical" | "horizontal";

/**
 * Which way `row` moves for a visual up/down arrow press, given orientation: `nodeXY` (metrics.ts)
 * makes row increase downward under "newest-top" and upward under "newest-bottom" (the whole
 * layout mirrors vertically, see metrics.ts's header comment) — this is the inverse of that
 * mapping, kept here (not metrics.ts) since it's arrow-key semantics, not pixel geometry.
 */
export function verticalRowDelta(direction: "up" | "down", order: NavOrder): 1 | -1 {
  const rowIncreasesDownward = order === "newest-top";
  if (direction === "down") return rowIncreasesDownward ? 1 : -1;
  return rowIncreasesDownward ? -1 : 1;
}

function nearestAlongAxis(
  nodes: NavNode[],
  current: NavNode,
  primaryKey: "row" | "lane",
  delta: 1 | -1,
): string | null {
  const secondaryKey = primaryKey === "row" ? "lane" : "row";
  let bestId: string | null = null;
  let bestPrimaryDiff = Infinity;
  let bestSecondaryDiff = Infinity;

  for (const node of nodes) {
    if (node.id === current.id) continue;
    const diff = node[primaryKey] - current[primaryKey];
    // Only consider nodes strictly on the requested side (never the current row/lane itself).
    if (delta === 1 ? diff <= 0 : diff >= 0) continue;

    const primaryDiff = Math.abs(diff);
    const secondaryDiff = Math.abs(node[secondaryKey] - current[secondaryKey]);
    if (primaryDiff < bestPrimaryDiff || (primaryDiff === bestPrimaryDiff && secondaryDiff < bestSecondaryDiff)) {
      bestId = node.id;
      bestPrimaryDiff = primaryDiff;
      bestSecondaryDiff = secondaryDiff;
    }
  }

  return bestId;
}

/** ↑/↓: nearest node in the adjacent row in `rowDelta`'s direction, same-lane preferred (falls
 * back to the row's nearest lane when there's no exact same-lane node in that row). Skips empty
 * rows automatically — "adjacent" means nearest occupied row, not literally row±1. */
export function findRowNeighbor(nodes: NavNode[], current: NavNode, rowDelta: 1 | -1): string | null {
  return nearestAlongAxis(nodes, current, "row", rowDelta);
}

/** ←/→: nearest node in the adjacent lane in `laneDelta`'s direction, same-row preferred (falls
 * back to that lane's nearest row otherwise). */
export function findLaneNeighbor(nodes: NavNode[], current: NavNode, laneDelta: 1 | -1): string | null {
  return nearestAlongAxis(nodes, current, "lane", laneDelta);
}

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** Which neighbor-finding function (`findRowNeighbor`/`findLaneNeighbor`) an arrow key should
 * drive, and the delta to pass it. */
export interface ArrowNavTarget {
  kind: "row" | "lane";
  delta: 1 | -1;
}

/**
 * Task H: axis-aware arrow-key mapping, keyboardNav.ts's one seam for "which physical key moves
 * along the chain vs across lanes". Vertical keeps the original scheme (↑/↓ = along-chain, ←/→ =
 * across-lane); horizontal is the inverse (←/→ = along-chain, ↑/↓ = across-lane) per the brief.
 *
 * Reuses `verticalRowDelta` rather than duplicating its order-flip math: that function's row
 * formula only depends on which key represents the "positive" spatial direction (the one `nodeXY`
 * increases toward under `newest-top`) — under vertical that's "down" (y increases downward);
 * under horizontal it's "right" (x increases rightward, see `nodeXY`'s `effRow`). Both are the same
 * shape of formula, just relabeled, so `ArrowRight`/`ArrowLeft` are passed through as `"down"`/
 * `"up"` here rather than re-deriving the same order-flip logic a second time. The lane axis needs
 * no such reuse — it's never mirrored by `order` in either axis (lane 0 is always at the
 * axis-agnostic "start": leftmost in vertical, topmost in horizontal), so its delta is a plain
 * +1/-1 off the key's spatial sign.
 */
export function arrowKeyTarget(key: ArrowKey, axis: NavAxis, order: NavOrder): ArrowNavTarget {
  const alongChainKeys: ArrowKey[] =
    axis === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];

  if (alongChainKeys.includes(key)) {
    const isPositiveDirection = key === "ArrowDown" || key === "ArrowRight";
    return { kind: "row", delta: verticalRowDelta(isPositiveDirection ? "down" : "up", order) };
  }
  const isPositiveDirection = key === "ArrowRight" || key === "ArrowDown";
  return { kind: "lane", delta: isPositiveDirection ? 1 : -1 };
}

// ---------- ghost blame (Task B2) ----------

/** render.ts's ghost-blame line, decomposed into plain data so the wording lives here (vitest),
 * not inline in DOM-construction code: the one visible text line, which action button (if any) to
 * offer, and the `title` tooltip text. */
export interface GhostBlameLine {
  text: string;
  button: "Restore" | "Import" | null;
  tooltip: string;
}

/**
 * Renders one `GhostBlame` (Task B1's gitDeletion.ts result, riding `AppState.ghostBlame`) into
 * the ghost card's blame line, per the design spec's UI section (verbatim wording):
 *   - `deleted-here`: "deleted in <shortCommit> · <author> · <date's first 10 chars>" + "Restore".
 *   - `never-existed` with `foundOn`: "never in this branch · introduced by <author> in
 *     <shortCommit>[ (cherry-pick)] · parent on <ref>" + "Import".
 *   - `never-existed` without `foundOn`: the same diagnosis (minus the "· parent on" clause, since
 *     there's no ref to name) plus " — fetch the source branch or drag to re-point", no button.
 * Callers (render.ts) only invoke this for a non-null, resolved blame — pending (key absent) or
 * `null` (searched-and-not-found) render nothing at all, per the spec, and are filtered out one
 * layer up rather than modeled as a fourth case here.
 */
export function ghostBlameLineText(blame: GhostBlame): GhostBlameLine {
  if (blame.kind === "deleted-here") {
    return {
      text: `deleted in ${blame.shortCommit} · ${blame.author} · ${blame.date.slice(0, 10)}`,
      button: "Restore",
      tooltip: blame.subject,
    };
  }

  const cherryPickSuffix = blame.cherryPickedFrom !== null ? " (cherry-pick)" : "";
  const diagnosis = `never in this branch · introduced by ${blame.introducedAuthor} in ${blame.introducedShortCommit}${cherryPickSuffix}`;

  if (blame.foundOn !== null) {
    return {
      text: `${diagnosis} · parent on ${blame.foundOn.ref}`,
      button: "Import",
      tooltip: blame.introducedSubject,
    };
  }

  return {
    text: `${diagnosis} — fetch the source branch or drag to re-point`,
    button: null,
    tooltip: blame.introducedSubject,
  };
}
