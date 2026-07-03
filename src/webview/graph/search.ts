/**
 * Toolbar revision search (Task 19, point 2): live-filter dimming, Enter/Shift+Enter cycling, and
 * the "N of M" count. Wired the same way as dnd.ts/contextMenu.ts — `attachSearch` is called again
 * after every render.ts rebuild (`renderStore()` in main.ts), operating on the FRESH toolbar
 * (`.alx-search-input`/`.alx-search-count`, built by render.ts) and canvas (`.alx-card` elements)
 * DOM directly.
 *
 * Deliberately does NOT trigger a `render()` on keystrokes: `render()` replaces the whole toolbar
 * subtree (see render.ts's header comment), which would tear down and recreate the very `<input>`
 * the user is typing into, dropping focus/cursor position on every character. Instead this module
 * patches `.alx-card--dimmed` directly on the existing canvas cards and updates the count text
 * node in place — genuinely re-rendering (a host "state" push, order/density toggle, ...) is the
 * only thing that legitimately needs to rebuild the input, and render.ts seeds its `.value` from
 * `initialQuery` so that path doesn't lose the in-progress query either (see main.ts's `store.search`).
 */
import { matchesQuery, nextMatchIndex, prevMatchIndex, type SearchableNode } from "./uxMath";

export interface SearchableCard extends SearchableNode {
  id: string;
}

export interface SearchCallbacks {
  /** Fired on every query change and cycle step, so main.ts's store can persist
   * `{query, index}` across a later full re-render without this module needing store access. */
  onStateChange(query: string, index: number): void;
  /** Fired on Enter/Shift+Enter with the match to center — main.ts's existing
   * `scrollNodeIntoView` centering (Task 12). */
  onNavigate(id: string): void;
}

/** Attaches search input handling to the freshly-rendered `toolbar`/`viewport` pair. `cards` is
 * the current revision node list to search over; `initialQuery`/`initialIndex` seed matches/count
 * from main.ts's persisted search state (render.ts already put `initialQuery` in the input's
 * `.value`). A no-op if render.ts didn't build the expected elements (defensive only). */
export function attachSearch(
  toolbar: HTMLElement,
  viewport: HTMLElement,
  cards: SearchableCard[],
  initialQuery: string,
  initialIndex: number,
  cb: SearchCallbacks,
): void {
  const input = toolbar.querySelector<HTMLInputElement>(".alx-search-input");
  const countEl = toolbar.querySelector<HTMLElement>(".alx-search-count");
  if (!input || !countEl) return;

  let matches = computeMatches(initialQuery, cards);
  let index = initialIndex;
  applyDimming(viewport, initialQuery, matches);
  updateCount(countEl, matches, index);

  input.addEventListener("input", () => {
    matches = computeMatches(input.value, cards);
    index = -1;
    applyDimming(viewport, input.value, matches);
    updateCount(countEl, matches, index);
    cb.onStateChange(input.value, index);
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // Owns Escape entirely while focused here: the input lives in the toolbar, outside
      // `.alx-canvas-viewport`, so it can never bubble into keyboardNav.ts's delegated listener —
      // but it WOULD otherwise reach contextMenu.ts's document-level Escape-closes-the-menu
      // listener. stopPropagation keeps "clear the search box" from also closing an unrelated
      // open menu.
      e.stopPropagation();
      input.value = "";
      matches = [];
      index = -1;
      applyDimming(viewport, "", matches);
      updateCount(countEl, matches, index);
      cb.onStateChange("", index);
      input.blur();
      return;
    }
    if (e.key === "Enter") {
      if (matches.length === 0) return;
      e.preventDefault();
      // Minor fix (Task 19 review, finding 3): see uxMath's nextMatchIndex/prevMatchIndex doc
      // comment — the inline `(index -/+ 1 + n) % n` formula this replaced landed the FIRST
      // Shift+Enter one match short of the last (e.g. "2 of 3" instead of "3 of 3" for 3 matches).
      index = e.shiftKey ? prevMatchIndex(index, matches.length) : nextMatchIndex(index, matches.length);
      updateCount(countEl, matches, index);
      cb.onStateChange(input.value, index);
      cb.onNavigate(matches[index]);
    }
  });
}

function computeMatches(query: string, cards: SearchableCard[]): string[] {
  const q = query.trim();
  if (q === "") return [];
  return cards.filter((c) => matchesQuery(q, c)).map((c) => c.id);
}

function applyDimming(viewport: HTMLElement, query: string, matchIds: string[]): void {
  const active = query.trim() !== "";
  const matchSet = new Set(matchIds);
  for (const card of viewport.querySelectorAll<HTMLElement>(".alx-card[data-node-id]")) {
    const id = card.dataset.nodeId;
    const dim = active && !(id !== undefined && matchSet.has(id));
    card.classList.toggle("alx-card--dimmed", dim);
  }
}

function updateCount(el: HTMLElement, matchIds: string[], index: number): void {
  if (matchIds.length === 0) {
    el.textContent = "";
    return;
  }
  const shown = index < 0 ? 1 : (index % matchIds.length) + 1;
  el.textContent = `${shown} of ${matchIds.length}`;
}
