/**
 * Revision detail side panel — the design's `hasDetails` block (`design/Alembic Graph.dc.html`).
 * DOM construction only (createElement/textContent — see render.ts's header comment for why),
 * fed entirely by the `RevisionDetail` the host computes (MigrationService.getDetail); this
 * module never touches AppState/LayoutNode directly. Only ever called with a non-null `detail` —
 * callers (render.ts) gate rendering on `detail !== null` so a null response just hides the panel.
 */
import type { RevisionDetail } from "../../protocol/messages";
import { buildBadgeItems } from "./badges";

export interface DetailHandlers {
  onClose(): void;
  onOpenFile(id: string): void;
}

/** Builds the 328px "Revision detail" panel. */
export function buildDetailPanel(detail: RevisionDetail, handlers: DetailHandlers): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "alx-detail-panel";
  panel.append(buildHeader(handlers), buildBody(detail, handlers));
  return panel;
}

function buildHeader(handlers: DetailHandlers): HTMLElement {
  const header = document.createElement("div");
  header.className = "alx-detail-header";

  const title = document.createElement("span");
  title.className = "alx-detail-title";
  title.textContent = "Revision detail";

  const close = document.createElement("div");
  close.className = "alx-detail-close";
  close.textContent = "✕";
  close.addEventListener("click", () => handlers.onClose());

  header.append(title, close);
  return header;
}

function buildBody(detail: RevisionDetail, handlers: DetailHandlers): HTMLElement {
  const body = document.createElement("div");
  body.className = "alx-detail-body";

  const hash = document.createElement("div");
  hash.className = "alx-detail-hash";
  hash.textContent = detail.hash;

  const message = document.createElement("div");
  message.className = "alx-detail-message";
  message.textContent = detail.message;

  body.append(buildBadgeRow(detail), hash, message, buildKeyValueRows(detail, handlers));

  if (detail.upgradeBody !== null && detail.downgradeBody !== null) {
    body.append(buildMigrationSection(detail.upgradeBody, detail.downgradeBody));
  }

  return body;
}

function buildBadgeRow(detail: RevisionDetail): HTMLElement {
  const row = document.createElement("div");
  row.className = "alx-detail-badges";
  row.append(...buildBadgeItems(detail));

  if (detail.branchLabel !== null) {
    const tag = document.createElement("div");
    tag.className = "alx-badge alx-badge--tag alx-detail-tag";
    tag.textContent = detail.branchLabel;
    row.append(tag);
  }
  return row;
}

function buildKeyValueRows(detail: RevisionDetail, handlers: DetailHandlers): HTMLElement {
  const kv = document.createElement("div");
  kv.className = "alx-detail-kv";
  kv.append(
    buildRow("author", detail.author ?? "—"),
    buildRow("date", detail.date ?? "—"),
    buildStatusRow(detail.applied),
    buildDownRevisionRow(detail.downRevisions),
    buildFileRow(detail, handlers),
  );
  return kv;
}

function buildRow(key: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "alx-detail-row";

  const k = document.createElement("span");
  k.className = "alx-detail-key";
  k.textContent = key;

  const v = document.createElement("span");
  v.className = "alx-detail-value";
  v.textContent = value;

  row.append(k, v);
  return row;
}

function buildStatusRow(applied: boolean | null): HTMLElement {
  const row = document.createElement("div");
  row.className = "alx-detail-row";

  const k = document.createElement("span");
  k.className = "alx-detail-key";
  k.textContent = "status";

  const v = document.createElement("span");
  const statusCls =
    applied === true ? "alx-detail-status--applied" : applied === false ? "alx-detail-status--pending" : "alx-detail-status--unknown";
  v.className = `alx-detail-value ${statusCls}`;
  v.textContent = applied === true ? "Applied" : applied === false ? "Pending" : "Unknown";

  row.append(k, v);
  return row;
}

function buildDownRevisionRow(downRevisions: RevisionDetail["downRevisions"]): HTMLElement {
  const row = document.createElement("div");
  row.className = "alx-detail-row alx-detail-row--start";

  const k = document.createElement("span");
  k.className = "alx-detail-key";
  k.textContent = "down_revision";

  const stack = document.createElement("div");
  stack.className = "alx-detail-parents";

  if (downRevisions.length === 0) {
    const none = document.createElement("span");
    none.className = "alx-detail-parent alx-detail-parent--none";
    none.textContent = "None  (base)";
    stack.append(none);
  } else {
    for (const parent of downRevisions) {
      const span = document.createElement("span");
      span.className = parent.missing ? "alx-detail-parent alx-detail-parent--missing" : "alx-detail-parent";
      span.textContent = parent.missing ? `${parent.id} (missing)` : parent.id;
      stack.append(span);
    }
  }

  row.append(k, stack);
  return row;
}

function buildFileRow(detail: RevisionDetail, handlers: DetailHandlers): HTMLElement {
  const row = document.createElement("div");
  row.className = "alx-detail-row alx-detail-row--start";

  const k = document.createElement("span");
  k.className = "alx-detail-key";
  k.textContent = "file";

  const v = document.createElement("span");
  v.className = "alx-detail-file";
  v.textContent = detail.filePath;
  v.title = "Open revision file";
  v.addEventListener("click", () => handlers.onOpenFile(detail.id));

  row.append(k, v);
  return row;
}

function buildMigrationSection(upgradeBody: string, downgradeBody: string): DocumentFragment {
  const frag = document.createDocumentFragment();

  const label = document.createElement("div");
  label.className = "alx-detail-section-label";
  label.textContent = "Migration";

  const code = document.createElement("div");
  code.className = "alx-detail-code";
  code.append(
    buildDefLine("upgrade"),
    ...buildCodeLines(upgradeBody),
    buildSpacer(),
    buildDefLine("downgrade"),
    ...buildCodeLines(downgradeBody),
  );

  frag.append(label, code);
  return frag;
}

function buildDefLine(fn: "upgrade" | "downgrade"): HTMLElement {
  const line = document.createElement("div");
  line.className = "alx-detail-code-def";

  const prefix = document.createElement("span");
  prefix.textContent = "def ";

  const name = document.createElement("span");
  name.className = "alx-detail-code-name";
  name.textContent = fn;

  const suffix = document.createElement("span");
  suffix.textContent = "():";

  line.append(prefix, name, suffix);
  return line;
}

/** One `<div>` per source line (textContent, `white-space:pre` via CSS so indentation survives);
 * a line whose trimmed text starts with `#` gets the comment color. */
function buildCodeLines(body: string): HTMLElement[] {
  if (body === "") return [];
  return body.split("\n").map((line) => {
    const el = document.createElement("div");
    el.className = line.trimStart().startsWith("#") ? "alx-detail-code-line alx-detail-code-comment" : "alx-detail-code-line";
    el.textContent = line;
    return el;
  });
}

function buildSpacer(): HTMLElement {
  const spacer = document.createElement("div");
  spacer.className = "alx-detail-code-spacer";
  return spacer;
}
