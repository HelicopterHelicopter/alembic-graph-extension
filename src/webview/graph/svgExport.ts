/**
 * Standalone SVG export of the CURRENT graph (Task 20) — pure string assembly, no DOM, so it's
 * testable directly in vitest and safe to build on the webview's `render()` thread without ever
 * touching `document`. Deliberately narrower than the live canvas: current order/density and the
 * FULL layout (every node, regardless of scroll/viewport) are captured, but search dimming, hover
 * ancestry, and card selection — all transient interaction state, not graph state — are NOT
 * exported (per the brief).
 *
 * Palette is hardcoded design hex, NOT the `--alx-*` CSS custom properties graph.css uses — this
 * file must render correctly opened directly in a browser, with no VS Code theme (or graph.css)
 * anywhere nearby. Values are copied 1:1 from graph.css's dark-theme defaults so the export matches
 * what the webview actually shows under VS Code's default dark theme.
 *
 * Every interpolated string that can originate from a user's workspace files (revision messages,
 * authors, branch labels, the project label derived from the ini path) is passed through
 * `escapeXml` before landing in the output — this file's whole raison d'être is producing
 * standalone XML, so an unescaped `<`/`&` in a commit message would silently corrupt the document.
 */
import type { GraphLayout, LayoutNode } from "../../core/types";
import type { AppState, UiPrefs } from "../../protocol/messages";
import { canvasSize, edgePathD, nodeSize, nodeXY, PAD_X, type Density } from "./metrics";

export interface SvgExportInput {
  layout: GraphLayout;
  laneColors: string[];
  ui: UiPrefs;
  counts: AppState["counts"];
  projectLabel: string;
}

interface Pos {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// System font stacks only (no embedded fonts, per the brief's "out of scope") — deliberately
// avoids any family name containing a space (e.g. "Segoe UI") so these can be dropped straight
// into an unquoted `font-family="..."` attribute without a nested-quote escaping headache.
const SVG_FONT = "system-ui, -apple-system, sans-serif";
const SVG_MONO = "ui-monospace, Menlo, Consolas, monospace";

const BG = "#1e1e1e";
const CARD_BG = "#2b2d2e";
const CARD_BORDER = "#3a3d41";
const TITLE_FG = "#8a8a8a";
const HASH_DIM = "#9a9a9a";
const HASH_APPLIED = "#d7d7d7";
const MSG_DIM = "#bdbdbd";
const MSG_APPLIED = "#eaeaea";
const META_FG = "#8a8a8a";
const GHOST_BORDER = "#f14c4c";
const GHOST_LABEL_FG = "#f0a0a0";
const GHOST_HASH_FG = "#cf9b9b";
const COLLAPSE_BORDER = "#4a4a4a";
const COLLAPSE_FG = "#8a8a8a";
const EDGE_COLLAPSE = "#555555";
const DEFAULT_LANE_COLOR = "#4aa3ff";

/** Same CURRENT/HEAD/MERGE/BROKEN palette as graph.css's `.alx-badge--*` classes. */
const BADGE_PALETTE: Record<string, { fg: string; bg: string; border: string }> = {
  CURRENT: { fg: "#ffffff", bg: "#0e639c", border: "#1c8fd6" },
  HEAD: { fg: "#0c2a16", bg: "#89d185", border: "#89d185" },
  MERGE: { fg: "#efe0ff", bg: "#5a3a80", border: "#8a5cc0" },
  BROKEN: { fg: "#ffffff", bg: "#b23838", border: "#f14c4c" },
};

/** Escapes the five predefined XML entities. Every interpolated string that can originate from a
 * user's workspace (revision messages, authors, branch labels, the project label) MUST go through
 * this before landing in the generated markup. `&` first, or its own replacement would double-escape
 * the entities just produced for `<`/`>`/etc. */
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Approximates rendered text width at ~7px/char for the card message's 12.5px/weight-600 font —
 * NOT a real font-metrics measurement (this module is DOM-free by design: no `canvas.measureText`,
 * no `document`, so it can run in plain vitest). Hard-truncates with a trailing "…" once the
 * (already-escaped-at-callsite) message would overflow `maxWidthPx`; reserves one character's width
 * for the ellipsis itself.
 */
function truncateMessage(message: string, maxWidthPx: number): string {
  const CHAR_WIDTH_PX = 7;
  const maxChars = Math.floor(maxWidthPx / CHAR_WIDTH_PX);
  if (message.length <= maxChars) return message;
  return `${message.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Same `author · date [· not applied]` composition as render.ts's `metaText` — duplicated (not
 * imported) since render.ts is a DOM-construction module and this one must stay DOM-free; the
 * format itself is tiny and low-churn enough that keeping two copies in sync is not a real risk. */
function metaTextFor(node: LayoutNode): string {
  const parts: string[] = [];
  if (node.author !== null) parts.push(node.author);
  if (node.dateLabel !== null) parts.push(node.dateLabel);
  let text = parts.join("   ·   ");
  if (node.applied === false) text = text ? `${text}   ·   not applied` : "not applied";
  return text;
}

/** Fixed CURRENT/HEAD/MERGE/BROKEN order, same as badges.ts's `buildBadgeItems`. */
function badgeList(node: LayoutNode): string[] {
  const items: string[] = [];
  if (node.isCurrent) items.push("CURRENT");
  if (node.isHead) items.push("HEAD");
  if (node.isMerge) items.push("MERGE");
  if (node.isBroken) items.push("BROKEN");
  return items;
}

/** Rough pill width for an 8.5px/weight-700 uppercase badge label: ~6px/char plus 10px of
 * horizontal padding (5px each side, matching graph.css's `.alx-badge` padding). Same
 * DOM-free-approximation rationale as `truncateMessage`. */
function badgeWidth(text: string): number {
  return text.length * 6 + 10;
}

function buildEdges(layout: GraphLayout, positions: Map<string, Pos>, laneColors: string[], axis: UiPrefs["axis"]): string {
  const parts: string[] = [];
  for (const edge of layout.edges) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) continue;

    const d = edgePathD(a, b, axis);
    let stroke = laneColors[edge.colorLane] ?? laneColors[0] ?? DEFAULT_LANE_COLOR;
    let dash = "";
    if (edge.kind === "broken") {
      stroke = GHOST_BORDER;
      dash = ' stroke-dasharray="5 4"';
    } else if (edge.kind === "collapse") {
      stroke = EDGE_COLLAPSE;
      dash = ' stroke-dasharray="3 5"';
    }
    parts.push(`<path d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="2" stroke-linecap="round"${dash}/>`);
  }
  return parts.join("");
}

/** `<g data-node-id="...">` open tag, shared by all three card builders below — the attribute
 * isn't consulted by anything in this file, but it gives external tooling (our own vitest suite,
 * and anyone poking at the exported file in a browser) a stable way to find "the group for node
 * X" without relying on draw order. Escaped like any other interpolated string per the brief, even
 * though real revision ids are plain hex and never need it in practice. */
function gOpen(id: string): string {
  return `<g data-node-id="${escapeXml(id)}">`;
}

function buildGhostCard(node: LayoutNode, pos: Pos): string {
  const midY = pos.y + pos.h / 2;
  const textX = pos.x + 14;
  return (
    gOpen(node.id) +
    `<rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="7" ` +
    `fill="${GHOST_BORDER}" fill-opacity="0.08" stroke="${GHOST_BORDER}" stroke-width="1.5" stroke-dasharray="4 3"/>` +
    `<text x="${textX}" y="${midY - 4}" font-family="${SVG_FONT}" font-size="11" font-weight="600" fill="${GHOST_LABEL_FG}">${escapeXml("⚠ missing revision")}</text>` +
    `<text x="${textX}" y="${midY + 12}" font-family="${SVG_MONO}" font-size="11" fill="${GHOST_HASH_FG}">${escapeXml(node.hash)}</text>` +
    `</g>`
  );
}

function buildCollapseCard(node: LayoutNode, pos: Pos): string {
  const count = node.collapsedCount ?? 0;
  const cx = pos.x + pos.w / 2;
  const cy = pos.y + pos.h / 2;
  return (
    gOpen(node.id) +
    `<rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="7" ` +
    `fill="#ffffff" fill-opacity="0.02" stroke="${COLLAPSE_BORDER}" stroke-dasharray="4 3"/>` +
    `<text x="${cx}" y="${cy + 4}" font-family="${SVG_FONT}" font-size="11.5" text-anchor="middle" fill="${COLLAPSE_FG}">${escapeXml(`⋮   ${count} earlier revisions`)}</text>` +
    `</g>`
  );
}

function buildRevisionCard(node: LayoutNode, pos: Pos, density: Density, laneColors: string[]): string {
  const laneColor = laneColors[node.lane] ?? laneColors[0] ?? DEFAULT_LANE_COLOR;
  const padLeft = density === "compact" ? 14 : 16;
  const padTop = density === "compact" ? 8 : 10;
  const padRight = density === "compact" ? 11 : 12;
  const rowStep = density === "compact" ? 17 : 20;
  const metaStep = density === "compact" ? 15 : 18;

  const parts: string[] = [gOpen(node.id)];

  parts.push(
    `<rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="7" fill="${CARD_BG}" stroke="${CARD_BORDER}"/>`,
  );
  const stripeOpacity = node.applied === false ? ' opacity="0.32"' : "";
  parts.push(`<rect x="${pos.x}" y="${pos.y}" width="4" height="${pos.h}" rx="2" fill="${escapeXml(laneColor)}"${stripeOpacity}/>`);

  const headBaselineY = pos.y + padTop + 9;
  const hashColor = node.applied === true ? HASH_APPLIED : HASH_DIM;
  parts.push(
    `<text x="${pos.x + padLeft}" y="${headBaselineY}" font-family="${SVG_MONO}" font-size="11" fill="${hashColor}">${escapeXml(node.hash)}</text>`,
  );

  // Badges, right-aligned on the header row, drawn right-to-left (same fixed order as badges.ts).
  const badgeH = 13;
  const badgeY = headBaselineY - badgeH + 2;
  let badgeRightEdge = pos.x + pos.w - padRight;
  for (const label of [...badgeList(node)].reverse()) {
    const palette = BADGE_PALETTE[label];
    const w = badgeWidth(label);
    const badgeX = badgeRightEdge - w;
    parts.push(
      `<rect x="${badgeX}" y="${badgeY}" width="${w}" height="${badgeH}" rx="4" fill="${palette.bg}" stroke="${palette.border}"/>` +
        `<text x="${badgeX + w / 2}" y="${badgeY + badgeH - 4}" font-family="${SVG_FONT}" font-size="8.5" font-weight="700" text-anchor="middle" fill="${palette.fg}">${label}</text>`,
    );
    badgeRightEdge = badgeX - 5;
  }

  const messageBaselineY = headBaselineY + rowStep;
  const msgColor = node.applied === true ? MSG_APPLIED : MSG_DIM;
  const maxMessageWidth = pos.w - padLeft - padRight;
  const truncated = truncateMessage(node.message, maxMessageWidth);
  parts.push(
    `<text x="${pos.x + padLeft}" y="${messageBaselineY}" font-family="${SVG_FONT}" font-size="12.5" font-weight="600" fill="${msgColor}">${escapeXml(truncated)}</text>`,
  );

  const metaBaselineY = messageBaselineY + metaStep;
  let metaX = pos.x + padLeft;
  if (node.branchLabel !== null) {
    const tagText = escapeXml(node.branchLabel);
    const tagW = node.branchLabel.length * 6 + 10;
    const tagY = metaBaselineY - 10;
    parts.push(
      `<rect x="${metaX}" y="${tagY}" width="${tagW}" height="13" rx="4" fill="none" stroke="${escapeXml(laneColor)}"/>` +
        `<text x="${metaX + tagW / 2}" y="${tagY + 9}" font-family="${SVG_FONT}" font-size="8.5" font-weight="700" text-anchor="middle" fill="${escapeXml(laneColor)}">${tagText}</text>`,
    );
    metaX += tagW + 6;
  }
  const meta = metaTextFor(node);
  if (meta) {
    parts.push(
      `<text x="${metaX}" y="${metaBaselineY}" font-family="${SVG_FONT}" font-size="10.5" fill="${META_FG}">${escapeXml(meta)}</text>`,
    );
  }

  parts.push(`</g>`);
  return parts.join("");
}

function computePositions(layout: GraphLayout, ui: UiPrefs, density: Density): Map<string, Pos> {
  const map = new Map<string, Pos>();
  for (const node of layout.nodes) {
    const { x, y } = nodeXY(node, ui, layout.rowCount, density);
    const { w, h } = nodeSize(node, density);
    map.set(node.id, {
      x,
      y,
      w,
      h,
      cx: x + w / 2,
      cy: y + h / 2,
      top: y,
      bottom: y + h,
      left: x,
      right: x + w,
    });
  }
  return map;
}

/** Builds one standalone, self-contained SVG document string for the current graph — the full
 * layout regardless of viewport scroll/zoom, at the current order/density. Renders correctly opened
 * directly in a browser (file:// or otherwise): no external stylesheet, no CSS custom properties,
 * no embedded/linked fonts (system monospace/sans-serif fallback only, per the brief). */
export function buildGraphSvg(input: SvgExportInput): string {
  const { layout, laneColors, ui, counts, projectLabel } = input;
  const density = ui.density;
  const size = canvasSize(layout, ui, density);
  const positions = computePositions(layout, ui, density);

  const nodeParts: string[] = [];
  for (const node of layout.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    if (node.kind === "ghost") nodeParts.push(buildGhostCard(node, pos));
    else if (node.kind === "collapse") nodeParts.push(buildCollapseCard(node, pos));
    else nodeParts.push(buildRevisionCard(node, pos, density, laneColors));
  }

  const subtitle = `${counts.revisions} revisions · ${counts.heads} heads`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}">` +
    `<rect x="0" y="0" width="${size.w}" height="${size.h}" fill="${BG}"/>` +
    `<text x="${PAD_X}" y="14" font-family="${SVG_FONT}" font-size="12" font-weight="600" fill="${TITLE_FG}">${escapeXml(projectLabel)}</text>` +
    `<text x="${PAD_X}" y="27" font-family="${SVG_FONT}" font-size="12" fill="${TITLE_FG}">${escapeXml(subtitle)}</text>` +
    buildEdges(layout, positions, laneColors, ui.axis) +
    nodeParts.join("") +
    `</svg>`
  );
}
