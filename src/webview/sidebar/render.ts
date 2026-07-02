/**
 * Alembic Migrations sidebar — DOM construction only (createElement/textContent, same rule as
 * graph/render.ts — see that file's header comment). Faithful port of the design file's left
 * 250px column (`design/Alembic Graph.dc.html`), minus the "Alembic Migrations" title bar (VS
 * Code already renders that from the view's `name` in package.json) and minus a selection
 * highlight for the currently-open graph node (accepted simplification — hover only, per the
 * Task 12 brief's "Out of scope").
 */
import type { Problem } from "../../core/types";
import type { AppState } from "../../protocol/messages";

export interface Handlers {
  onSelect(id: string): void;
  onUpgrade(): void;
}

/** Renders the full sidebar into `root`, replacing its previous contents. */
export function render(root: HTMLElement, state: AppState, handlers: Handlers): void {
  root.className = "alx-side-root";

  // Defensive, mirroring graph/render.ts: MigrationService always sets `project` when it exists
  // (see sidebarView.ts — the no-project host never sends a "state" message at all), but the
  // protocol allows it, so a state message that somehow carries a null project still degrades to
  // the same empty view instead of rendering with a null project reference.
  if (state.project === null) {
    root.replaceChildren(buildEmptyState());
    return;
  }

  const scroll = document.createElement("div");
  scroll.className = "alx-side-scroll";
  scroll.append(buildHeadsSection(state, handlers), buildCurrentSection(state), buildProblemsSection(state));

  root.replaceChildren(scroll, buildFooter(handlers));
}

/** Client-side-only placeholder rendered the instant the webview boots, before the host has had a
 * chance to say anything at all — the host's initial scan is still in flight (or hasn't started),
 * so we don't yet know whether there's a project. Neutral/dim, not a diagnosis: it must not claim
 * "no alembic.ini" when the truth is simply "haven't heard back yet". Replaced by render() if a
 * "state" message lands, or by renderNoProject() if the host reports "noProject" — see main.ts. */
export function renderScanning(root: HTMLElement): void {
  root.className = "alx-side-root";
  root.replaceChildren(buildScanningState());
}

/** Rendered once the host explicitly reports it found no alembic.ini anywhere in the workspace
 * (the "noProject" message — see sidebarView.ts's `ready` handler, where `service === null`). */
export function renderNoProject(root: HTMLElement): void {
  root.className = "alx-side-root";
  root.replaceChildren(buildEmptyState());
}

function buildScanningState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "alx-side-empty alx-side-empty--centered";

  const message = document.createElement("div");
  message.className = "alx-side-empty-message alx-side-empty-message--dim";
  message.textContent = "Scanning migrations…";

  wrap.append(message);
  return wrap;
}

function buildEmptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "alx-side-empty";

  const message = document.createElement("div");
  message.className = "alx-side-empty-message";
  message.textContent = "No alembic.ini found in this workspace";

  const hint = document.createElement("div");
  hint.className = "alx-side-empty-hint";
  hint.textContent = "Open a workspace folder that contains an Alembic project to get started.";

  wrap.append(message, hint);
  return wrap;
}

// ---------- section header ----------

function buildSectionHeader(text: string, opts: { count?: number; spaced?: boolean } = {}): HTMLElement {
  const header = document.createElement("div");
  header.className = opts.spaced ? "alx-side-section-header alx-side-section-header--spaced" : "alx-side-section-header";

  const label = document.createElement("span");
  label.textContent = text;
  header.append(label);

  if (opts.count !== undefined) {
    const pill = document.createElement("span");
    pill.className = "alx-side-count-pill";
    pill.textContent = String(opts.count);
    header.append(pill);
  }

  return header;
}

// ---------- heads ----------

function buildHeadsSection(state: AppState, handlers: Handlers): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(buildSectionHeader("▾ Heads", { count: state.counts.heads }));
  for (const head of state.heads) frag.append(buildHeadRow(head, handlers));
  return frag;
}

function buildHeadRow(head: AppState["heads"][number], handlers: Handlers): HTMLElement {
  const row = document.createElement("div");
  row.className = "alx-side-head-row";
  row.addEventListener("click", () => handlers.onSelect(head.id));

  const dot = document.createElement("span");
  dot.className = "alx-side-head-dot";
  dot.textContent = "◆";

  const hash = document.createElement("span");
  hash.className = "alx-side-hash";
  hash.textContent = head.id.slice(0, 10);

  const message = document.createElement("span");
  message.className = "alx-side-head-message";
  message.textContent = head.message;

  row.append(dot, hash, message);
  return row;
}

// ---------- current revision ----------

function buildCurrentSection(state: AppState): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(buildSectionHeader("Current revision", { spaced: true }));

  const row = document.createElement("div");
  row.className = "alx-side-current-row";

  // DB state enrichment (Task 13) is what ever populates currentIds — until then this is always
  // empty and the row shows the hollow-dot "unknown" state.
  const currentId = state.currentIds[0] ?? null;

  const dot = document.createElement("span");
  dot.className = currentId !== null ? "alx-side-current-dot" : "alx-side-current-dot alx-side-current-dot--hollow";

  const hash = document.createElement("span");
  if (currentId !== null) {
    hash.className = "alx-side-hash";
    hash.textContent = currentId.slice(0, 10);
  } else {
    hash.className = "alx-side-dim";
    hash.textContent = "unknown";
  }

  row.append(dot, hash);
  frag.append(row);
  return frag;
}

// ---------- problems ----------

function buildProblemsSection(state: AppState): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(buildSectionHeader("Problems", { spaced: true }));

  if (state.problems.length === 0) {
    const none = document.createElement("div");
    none.className = "alx-side-no-problems";
    none.textContent = "No problems";
    frag.append(none);
    return frag;
  }

  // Design shows a single "N broken down_revision" count; per-problem summaries are strictly more
  // useful (each already carries a human-readable one-liner) — sanctioned deviation, see the
  // Task 12 brief.
  for (const problem of state.problems) frag.append(buildProblemRow(problem));
  return frag;
}

function buildProblemRow(problem: Problem): HTMLElement {
  const row = document.createElement("div");
  row.className = "alx-side-problem-row";

  const icon = document.createElement("span");
  icon.className = "alx-side-problem-icon";
  icon.textContent = "⚠";

  const summary = document.createElement("span");
  summary.className = "alx-side-problem-summary";
  summary.textContent = problem.summary;

  row.append(icon, summary);
  return row;
}

// ---------- footer ----------

function buildFooter(handlers: Handlers): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "alx-side-footer";

  const button = document.createElement("div");
  button.className = "alx-side-upgrade-btn";
  button.textContent = "↻ alembic upgrade head";
  button.addEventListener("click", () => handlers.onUpgrade());

  footer.append(button);
  return footer;
}
