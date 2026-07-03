/**
 * Pointer-driven drag-to-merge for HEAD cards — the ported, event-delegated equivalent of the
 * design file's `down()`/`onMove()`/`onUp()`/`mergeHeads()` state machine (see
 * `design/Alembic Graph.dc.html`). Two structural differences from the design, both required by
 * this being a real webview rather than a React-style component:
 *
 * 1. The design re-renders the whole tree on every drag frame (`setState({dx, dy, ...})`); here
 *    that would tear down the very card holding pointer capture mid-drag. Instead this module
 *    mutates the live DOM directly (inline `transform`/classes) and never touches render.ts while
 *    dragging — main.ts is responsible for deferring any incoming "state" re-render until the
 *    drag ends (see its `onDragActiveChange` callback below).
 * 2. Click-to-select is a separate, pre-existing `click` listener per card (render.ts), not part
 *    of this state machine — a plain click (no drag) must keep working untouched. Since
 *    `setPointerCapture` retargets the synthesized `click` that follows `pointerup` to the
 *    capturing element, a REAL drag+drop would otherwise still fire that card's own `onSelect`
 *    right after the drop. `suppressNextClick` (a capture-phase listener on the viewport) swallows
 *    exactly that one click, and only that one.
 */
import type { AppState } from "../../protocol/messages";

export interface DndCallbacks {
  onMergeDrop(a: string, b: string): void;
  isEnabled(): boolean;
  /** Called synchronously the instant a drag starts (true) and again once it fully ends —
   * successful drop, revert, or cancel (false, deferred one macrotask so any click the browser
   * synthesizes right after `pointerup` has already been dispatched — see the module doc comment).
   * main.ts uses this to defer/flush incoming "state" re-renders while a card holds pointer
   * capture. */
  onDragActiveChange(active: boolean): void;
}

const DRAG_THRESHOLD_PX = 4;

interface DragState {
  pointerId: number;
  originId: string;
  originCard: HTMLElement;
  originWrapper: HTMLElement;
  originZIndex: string;
  startX: number;
  startY: number;
  dragging: boolean;
  targetCard: HTMLElement | null;
}

/**
 * Attaches drag-to-merge handling to `viewport` (the `.alx-canvas-viewport` element — a fresh one
 * every render, per render.ts, so this must be called again after every re-render, same as
 * main.ts's scroll listener). `state` is used only to validate that a `data-head="true"` card's id
 * is still a real current head (defensive — render.ts's own `node.isHead` is the source of truth
 * for the attribute, this just guards against a stale/mismatched DOM in case a future change ever
 * decouples the two).
 */
export function attachDnd(viewport: HTMLElement, state: AppState, cb: DndCallbacks): void {
  const headIds = new Set(state.heads.map((h) => h.id));
  let drag: DragState | null = null;
  let suppressNextClick = false;

  function headCards(): HTMLElement[] {
    return Array.from(viewport.querySelectorAll<HTMLElement>('[data-head="true"]')).filter((el) => {
      const id = el.dataset.nodeId;
      return id !== undefined && headIds.has(id);
    });
  }

  function endDrag(revert: boolean): void {
    if (!drag) return;
    const wasDragging = drag.dragging;
    if (revert) {
      drag.originWrapper.style.transform = "";
      drag.originWrapper.style.zIndex = drag.originZIndex;
    }
    drag.originCard.classList.remove("alx-card--dragging");
    drag.targetCard?.classList.remove("alx-card--merge-target");
    if (drag.originCard.hasPointerCapture(drag.pointerId)) {
      drag.originCard.releasePointerCapture(drag.pointerId);
    }
    document.removeEventListener("keydown", onKeyDown);
    drag = null;

    if (wasDragging) {
      // Deferred: see the module doc comment (point 2) — a synchronous re-render here could
      // detach the origin card before the browser's own post-pointerup `click` reaches it.
      setTimeout(() => cb.onDragActiveChange(false), 0);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") endDrag(true);
  }

  function onClickCapture(e: MouseEvent): void {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    e.stopPropagation();
    e.preventDefault();
  }

  function onPointerDown(e: PointerEvent): void {
    // One drag at a time: ignore a second pointerdown (multi-touch, or a second mouse button)
    // that arrives while a drag is already tracking a different pointer — starting a new one here
    // would silently orphan the first (its pointer never released, its transform/classes stuck).
    if (drag || e.button !== 0 || !cb.isEnabled()) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-head="true"]');
    if (!card || !viewport.contains(card)) return;
    const originId = card.dataset.nodeId;
    if (!originId || !headIds.has(originId)) return;
    const wrapper = card.closest<HTMLElement>(".alx-node");
    if (!wrapper) return;

    drag = {
      pointerId: e.pointerId,
      originId,
      originCard: card,
      originWrapper: wrapper,
      originZIndex: wrapper.style.zIndex,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      targetCard: null,
    };
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      drag.originCard.setPointerCapture(drag.pointerId);
      drag.originCard.classList.add("alx-card--dragging");
      drag.originWrapper.style.zIndex = "60";
      document.addEventListener("keydown", onKeyDown);
      cb.onDragActiveChange(true);
    }

    e.preventDefault();
    drag.originWrapper.style.transform = `translate(${dx}px, ${dy}px)`;

    let hit: HTMLElement | null = null;
    for (const other of headCards()) {
      if (other === drag.originCard) continue;
      const rect = other.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        hit = other;
        break;
      }
    }
    if (hit !== drag.targetCard) {
      drag.targetCard?.classList.remove("alx-card--merge-target");
      hit?.classList.add("alx-card--merge-target");
      drag.targetCard = hit;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasDragging = drag.dragging;
    const originId = drag.originId;
    const targetId = drag.targetCard?.dataset.nodeId ?? null;
    if (wasDragging) suppressNextClick = true;
    endDrag(true);
    if (wasDragging && targetId) cb.onMergeDrop(originId, targetId);
  }

  function onPointerCancel(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    endDrag(true);
  }

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("pointercancel", onPointerCancel);
  // Capture phase so this runs before the card's own bubble-phase click listener (render.ts).
  viewport.addEventListener("click", onClickCapture, true);
}
