/**
 * Pointer-driven drag-to-merge (Task 14) AND ghost-drag repoint (Task 15) for the graph canvas —
 * the ported, event-delegated equivalent of the design file's `down()`/`onMove()`/`onUp()`/
 * `mergeHeads()`/`repoint()` state machine (see `design/Alembic Graph.dc.html`). Two structural
 * differences from the design, both required by this being a real webview rather than a
 * React-style component:
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
 *
 * A THIRD, deliberate difference from the design just for repoint: the design only rings the one
 * card currently under the pointer (`S.hoverTargetId`). Per the Task 15 brief, a repoint drag
 * instead rings EVERY real revision card as a valid drop target the instant the drag starts (the
 * host — MigrationService.getRepointPlan — is what actually enforces the cycle guard, on drop; the
 * webview doesn't try to predict it) — merge's single-hovered-target ring is unchanged.
 *
 * Drag-source classification (mutually exclusive, set by render.ts's data attributes):
 *  - `[data-head="true"]` → merge. A head wins even if it's also broken — see render.ts's
 *    `buildRevisionCard` — so this check runs first.
 *  - `[data-repoint-ghost-id]` → repoint. Set on every ghost card (value = its own id, the missing
 *    revision) and on every broken NON-head revision card (value = the missing parent id it
 *    revises — NOT its own id).
 */
import type { AppState } from "../../protocol/messages";

export interface DndCallbacks {
  onMergeDrop(a: string, b: string): void;
  /** `ghostId` is the missing revision id being repaired (see the module doc comment on
   * `[data-repoint-ghost-id]`), `targetId` is the real revision card it was dropped on. */
  onRepointDrop(ghostId: string, targetId: string): void;
  isEnabled(): boolean;
  /** Called synchronously the instant a drag starts (true) and again once it fully ends —
   * successful drop, revert, or cancel (false, deferred one macrotask so any click the browser
   * synthesizes right after `pointerup` has already been dispatched — see the module doc comment).
   * main.ts uses this to defer/flush incoming "state" re-renders while a card holds pointer
   * capture. */
  onDragActiveChange(active: boolean): void;
}

const DRAG_THRESHOLD_PX = 4;

type DragKind = "merge" | "repoint";

interface DragState {
  pointerId: number;
  kind: DragKind;
  /** merge: the dragged head's own id. repoint: the ghost (missing revision) id being repaired —
   * see the module doc comment on `[data-repoint-ghost-id]`. Either way, this is the first
   * argument of the eventual `onMergeDrop`/`onRepointDrop` call. */
  originId: string;
  originCard: HTMLElement;
  originWrapper: HTMLElement;
  originZIndex: string;
  startX: number;
  startY: number;
  dragging: boolean;
  targetCard: HTMLElement | null;
  /** repoint only: every card ringed as a valid drop target at drag-start (see the module doc
   * comment's third design difference), so they can all be un-ringed on end. Always empty for a
   * merge drag — merge rings only the single hovered target instead, toggled per pointermove. */
  repointTargets: HTMLElement[];
}

/**
 * Attaches drag-to-merge/drag-to-repoint handling to `viewport` (the `.alx-canvas-viewport`
 * element — a fresh one every render, per render.ts, so this must be called again after every
 * re-render, same as main.ts's scroll listener). `state` is used only to validate that a
 * `data-head="true"` card's id is still a real current head (defensive — render.ts's own
 * `node.isHead` is the source of truth for the attribute, this just guards against a stale/
 * mismatched DOM in case a future change ever decouples the two).
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

  /** Every real revision card eligible as a repoint drop target (ghost/collapse cards use
   * different classes and are never `.alx-card`), excluding `exclude` (the drag origin itself —
   * only matters when that's a broken non-head revision card dragging itself; a no-op exclusion
   * for a ghost origin, which never has the `.alx-card` class to begin with). NOT filtered by the
   * cycle guard — see the module doc comment. */
  function repointTargetCards(exclude: HTMLElement): HTMLElement[] {
    return Array.from(viewport.querySelectorAll<HTMLElement>(".alx-card[data-node-id]")).filter(
      (el) => el !== exclude,
    );
  }

  function endDrag(revert: boolean): void {
    if (!drag) return;
    const wasDragging = drag.dragging;
    if (revert) {
      drag.originWrapper.style.transform = "";
      drag.originWrapper.style.zIndex = drag.originZIndex;
    }
    drag.originCard.classList.remove("alx-card--dragging");
    if (drag.kind === "merge") {
      drag.targetCard?.classList.remove("alx-card--merge-target");
    } else {
      for (const c of drag.repointTargets) c.classList.remove("alx-card--repoint-target");
    }
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
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-head="true"], [data-repoint-ghost-id]');
    if (!card || !viewport.contains(card)) return;
    const wrapper = card.closest<HTMLElement>(".alx-node");
    if (!wrapper) return;

    let kind: DragKind;
    let originId: string;
    // A head wins even if it's also broken (render.ts never sets data-repoint-ghost-id on a head
    // card) — so checking data-head first is enough to keep the two kinds mutually exclusive.
    if (card.dataset.head === "true") {
      const id = card.dataset.nodeId;
      if (!id || !headIds.has(id)) return;
      kind = "merge";
      originId = id;
    } else {
      const ghostId = card.dataset.repointGhostId;
      if (!ghostId) return;
      kind = "repoint";
      originId = ghostId;
    }

    drag = {
      pointerId: e.pointerId,
      kind,
      originId,
      originCard: card,
      originWrapper: wrapper,
      originZIndex: wrapper.style.zIndex,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      targetCard: null,
      repointTargets: [],
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
      if (drag.kind === "repoint") {
        drag.repointTargets = repointTargetCards(drag.originCard);
        for (const c of drag.repointTargets) c.classList.add("alx-card--repoint-target");
      }
      cb.onDragActiveChange(true);
    }

    e.preventDefault();
    drag.originWrapper.style.transform = `translate(${dx}px, ${dy}px)`;

    const candidates = drag.kind === "merge" ? headCards() : drag.repointTargets;
    let hit: HTMLElement | null = null;
    for (const other of candidates) {
      if (other === drag.originCard) continue;
      const rect = other.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        hit = other;
        break;
      }
    }

    if (drag.kind === "merge") {
      if (hit !== drag.targetCard) {
        drag.targetCard?.classList.remove("alx-card--merge-target");
        hit?.classList.add("alx-card--merge-target");
        drag.targetCard = hit;
      }
    } else {
      // Every valid repoint target is already ringed (set above, once, at drag-start) — this just
      // tracks which one the pointer happens to be over right now, for onPointerUp's drop decision.
      drag.targetCard = hit;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasDragging = drag.dragging;
    const kind = drag.kind;
    const originId = drag.originId;
    const targetId = drag.targetCard?.dataset.nodeId ?? null;
    if (wasDragging) suppressNextClick = true;
    endDrag(true);
    if (wasDragging && targetId) {
      if (kind === "merge") cb.onMergeDrop(originId, targetId);
      else cb.onRepointDrop(originId, targetId);
    }
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
