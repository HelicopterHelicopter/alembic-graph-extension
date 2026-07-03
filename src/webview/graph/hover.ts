/**
 * Ancestry highlight on hover (Task 19, point 3): hovering a revision card for >=150ms (debounced,
 * so a drive-by mouse pass never flickers it) lights the hovered card + its ancestor chain
 * (`alx-card--lit` / `alx-edge--lit`) and fades everything else (`alx-card--faded` /
 * `alx-edge--faded`). Wired the same way as dnd.ts/contextMenu.ts — `attachHover` is called again
 * after every render.ts rebuild, and mutates the live canvas DOM directly (never calls render() —
 * a hover shouldn't invalidate the FLIP snapshot or steal focus from a keyboard-navigated card).
 */
import type { GraphLayout } from "../../core/types";
import { computeAncestorSet } from "./uxMath";

const HOVER_DELAY_MS = 150;

export interface HoverCallbacks {
  /** True while ancestry highlight should be suppressed entirely: mid-drag, a context menu open,
   * or search dimming active (search wins — see the brief). Checked both before arming the debounce
   * timer and again when it fires, since either can become true during the 150ms wait. */
  isSuppressed(): boolean;
}

/** Attaches hover-ancestry handling to the freshly-rendered `viewport`. `layout` supplies both the
 * ancestor walk (`downRevisions`) and the edge list to light/fade. */
export function attachHover(viewport: HTMLElement, layout: GraphLayout, cb: HoverCallbacks): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeId: string | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function clearHighlight(): void {
    clearTimer();
    if (activeId === null) return;
    activeId = null;
    for (const el of viewport.querySelectorAll<HTMLElement>(".alx-card--lit, .alx-card--faded")) {
      el.classList.remove("alx-card--lit", "alx-card--faded");
    }
    for (const el of viewport.querySelectorAll<SVGPathElement>(".alx-edge--lit, .alx-edge--faded")) {
      el.classList.remove("alx-edge--lit", "alx-edge--faded");
    }
  }

  function applyHighlight(id: string): void {
    activeId = id;
    const ancestors = computeAncestorSet(id, layout.nodes);
    for (const card of viewport.querySelectorAll<HTMLElement>(".alx-card[data-node-id]")) {
      const nodeId = card.dataset.nodeId;
      card.classList.add(nodeId !== undefined && ancestors.has(nodeId) ? "alx-card--lit" : "alx-card--faded");
    }
    for (const path of viewport.querySelectorAll<SVGPathElement>(".alx-edge")) {
      const from = path.dataset.from;
      const to = path.dataset.to;
      const onPath = from !== undefined && to !== undefined && ancestors.has(from) && ancestors.has(to);
      path.classList.add(onPath ? "alx-edge--lit" : "alx-edge--faded");
    }
  }

  viewport.addEventListener("mouseover", (e: MouseEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".alx-card[data-node-id]");
    if (!card || !viewport.contains(card)) return;
    const id = card.dataset.nodeId;
    if (!id || id === activeId) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (cb.isSuppressed()) return;
      applyHighlight(id);
    }, HOVER_DELAY_MS);
  });

  viewport.addEventListener("mouseout", (e: MouseEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".alx-card[data-node-id]");
    if (!card) return;
    const related = e.relatedTarget as Node | null;
    if (related && card.contains(related)) return; // moved within the same card — not a real leave
    clearHighlight();
  });

  registerClearHook(clearHighlight);
}

/** The most recently attached instance's clear function — main.ts calls `clearActiveHover()` the
 * instant a drag starts (dnd.ts's `onDragActiveChange(true)`), since dragging doesn't re-render
 * the canvas (see dnd.ts's header comment) and so wouldn't otherwise naturally reset a highlight
 * already mid-flight when the drag began. Every OTHER suppression trigger (context menu open,
 * search becoming active) is covered by `isSuppressed()` gating new highlights — this hook only
 * needs to cover the one case where an ALREADY-applied highlight must be torn down without a
 * re-render happening to do it for free. */
let activeClear: (() => void) | null = null;

function registerClearHook(clear: () => void): void {
  activeClear = clear;
}

export function clearActiveHover(): void {
  activeClear?.();
}
