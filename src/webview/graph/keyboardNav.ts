/**
 * Canvas keyboard navigation (Task 19, point 5). Cards carry `tabindex="0"`/`role="button"`
 * (render.ts) so they're natively Tab-reachable and keydown-focusable; this module delegates a
 * single `keydown` listener on the viewport (re-attached every render, same pattern as
 * dnd.ts/contextMenu.ts) that only acts when the event's target is (or is inside) a revision card
 * — i.e. exactly "when a card has focus", per the brief, since a keydown only ever targets the
 * currently focused element.
 *
 * Arrow keys resolve the neighbor via uxMath's pure `findRowNeighbor`/`findLaneNeighbor` and hand
 * off to `handlers.onNavigate`, which (main.ts) selects it exactly like a click AND moves DOM
 * focus + scrolls it into view — that combined step can't live here: main.ts's `onSelect` triggers
 * a synchronous `renderStore()` that rebuilds the canvas wholesale, so the `viewport`/card
 * references this module closed over would already be stale (detached) by the time it returned;
 * only main.ts can safely re-query the FRESH DOM afterward.
 *
 * Task H: which physical arrow key means "along the chain" vs "across lanes" flips with `axis` —
 * `uxMath.arrowKeyTarget` is the single seam that resolves a key + axis + order down to a
 * `findRowNeighbor`/`findLaneNeighbor` call, so this module doesn't duplicate that mapping per axis.
 */
import type { NavAxis, NavNode, NavOrder } from "./uxMath";
import { arrowKeyTarget, findLaneNeighbor, findRowNeighbor } from "./uxMath";

export interface KeyboardNavHandlers {
  /** Arrow-key move: select `id` (post + detail fetch, like a click) and focus/scroll it into view. */
  onNavigate(id: string): void;
  /** Enter: open the focused revision's source file. */
  onOpenFile(id: string): void;
  /** Space: toggle the detail panel open/closed. */
  onToggleDetail(): void;
  /** Escape: close the detail panel if open, else clear the current selection. */
  onEscape(): void;
}

/** Attaches keyboard navigation to the freshly-rendered `viewport`. `nodes` should be the current
 * REVISION nodes only (ghost/collapse cards aren't focusable — see render.ts, they get no
 * tabindex). `order` and `axis` together drive which arrow key resolves to which neighbor (see
 * `uxMath.arrowKeyTarget`). */
export function attachKeyboardNav(
  viewport: HTMLElement,
  nodes: NavNode[],
  order: NavOrder,
  axis: NavAxis,
  handlers: KeyboardNavHandlers,
): void {
  viewport.addEventListener("keydown", (e: KeyboardEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".alx-card[data-node-id]");
    if (!card || !viewport.contains(card)) return;
    const currentId = card.dataset.nodeId;
    if (!currentId) return;
    const current = nodes.find((n) => n.id === currentId);
    if (!current) return;

    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const target = arrowKeyTarget(e.key, axis, order);
        const next =
          target.kind === "row"
            ? findRowNeighbor(nodes, current, target.delta)
            : findLaneNeighbor(nodes, current, target.delta);
        if (next) handlers.onNavigate(next);
        break;
      }
      case "Enter":
        e.preventDefault();
        handlers.onOpenFile(currentId);
        break;
      case " ":
      case "Spacebar":
        e.preventDefault();
        handlers.onToggleDetail();
        break;
      case "Escape":
        e.preventDefault();
        handlers.onEscape();
        break;
      default:
        break;
    }
  });
}
