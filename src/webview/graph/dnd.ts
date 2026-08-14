/**
 * Pointer-driven FREEFORM topology drag (the freeform-topology task) AND ghost-drag repoint
 * (Task 15) for the graph canvas — the event-delegated state machine behind every drag gesture on
 * the canvas. It grew out of the design file's `down()`/`onMove()`/`onUp()`/`mergeHeads()`/
 * `repoint()` port (see `design/Alembic Graph.dc.html`); two structural differences from that
 * design, both required by this being a real webview rather than a React-style component, still
 * hold and are the invariants everything below is written around:
 *
 * 1. The design re-renders the whole tree on every drag frame (`setState({dx, dy, ...})`); here
 *    that would tear down the very card holding pointer capture mid-drag. Instead this module
 *    mutates the live DOM directly (inline `transform`/classes) and never touches render.ts while
 *    dragging — main.ts is responsible for deferring any incoming "state" re-render until the
 *    drag ends (see its `onDragActiveChange` callback below). The drag hint pill is appended to
 *    `document.body` for the same family of reason: it must not live inside the subtree a
 *    re-render would replace.
 * 2. Click-to-select is a separate, pre-existing `click` listener per card (render.ts), not part
 *    of this state machine — a plain click (no drag) must keep working untouched. Since
 *    `setPointerCapture` retargets the synthesized `click` that follows `pointerup` to the
 *    capturing element, a REAL drag+drop would otherwise still fire that card's own `onSelect`
 *    right after the drop. `suppressNextClick` (a capture-phase listener on the viewport) swallows
 *    exactly that one click, and only that one.
 *
 * A THIRD, deliberate difference from the design: the design only rings the one card currently
 * under the pointer (`S.hoverTargetId`). Both drag kinds here instead ring EVERY eligible card the
 * instant the drag starts — repoint rings every real revision card (the host, via
 * MigrationService.getRepointPlan, is what actually enforces the cycle guard on drop; the webview
 * doesn't try to predict it), and a freeform drag rings every non-origin revision card as either a
 * valid target (`alx-card--freeform-target`) or an explicitly invalid one
 * (`alx-card--invalid-target`), per uxMath.ts's `isValidFreeformNodeTarget`. Edges get no
 * pre-ring — with one twin per parent link that would be visual noise — so only the edge currently
 * under the pointer lights up (`alx-edge--drop-target` on its VISIBLE twin).
 *
 * Task 19 (zoom): the dragged `.alx-node` wrapper lives INSIDE `.alx-canvas`, which now carries a
 * `transform: scale(zoom)` (render.ts). A `translate(dx, dy)` set on a descendant of a scaled
 * ancestor is interpreted in that ancestor's LOCAL (pre-scale) coordinate space, so visually it
 * renders as `(dx*zoom, dy*zoom)` on screen — dividing the raw client-pixel pointer delta by
 * `zoom` before applying it as the translate is what makes the dragged card track the cursor 1:1
 * at any zoom level. Hit-testing needs NO such adjustment: both the repoint branch's
 * `getBoundingClientRect()` loop and the freeform branch's `document.elementsFromPoint` work in
 * real, post-transform screen coordinates regardless of zoom.
 *
 * Drag-source classification (mutually exclusive, set by render.ts's data attributes):
 *  - `[data-repoint-ghost-id]` → repoint. Now set ONLY on ghost cards (value = its own id, the
 *    missing revision); a ghost card carries no `.alx-card` class, which is what keeps the two
 *    kinds disjoint. Checked FIRST for that reason.
 *  - `.alx-card[data-node-id]` → freeform. Every revision card, heads included. Collapse cards
 *    match neither selector and are not draggable.
 *
 * The merge gesture no longer has a drag kind of its own (it used to be `[data-head="true"]` →
 * `"merge"`). Dropping a head onto another head is a plain freeform node drop; main.ts's
 * `onFreeformDrop` is what offers "Merge heads" vs "Move here" in a drop-time popover
 * (dropChoice.ts) and posts the merge from there — which is why `onMergeDrop` survives on the
 * callback interface below even though nothing in this file calls it anymore.
 */
import type { AppState } from "../../protocol/messages";
import { dragHintText, isValidFreeformEdgeTarget, isValidFreeformNodeTarget } from "./uxMath";

export interface DndCallbacks {
  /** No longer called from this module — kept as the one place a "a drop decided to merge these
   * two" post lives, now invoked by main.ts from the head-on-head drop popover (see the module doc
   * comment's last paragraph). */
  onMergeDrop(a: string, b: string): void;
  /** `ghostId` is the missing revision id being repaired (see the module doc comment on
   * `[data-repoint-ghost-id]`), `targetId` is the real revision card it was dropped on. */
  onRepointDrop(ghostId: string, targetId: string): void;
  /**
   * Everything the drag machine needs to know about a freeform drag source, asked ONCE the instant
   * the pointer crosses the drag threshold (never per frame — `descendantIds` is a graph walk).
   * `null` means "this id isn't freeform-draggable after all" (defensive: an id with no layout node,
   * or a ghost/collapse node), and the drag is abandoned silently instead of started.
   *
   * `descendantIds` is a plain array rather than a Set purely so this stays a data-shaped callback;
   * the drag copies it into a Set for the per-frame predicate checks.
   */
  getFreeformInfo(nodeId: string): { chainCount: number; descendantIds: string[]; isMerge: boolean; isHead: boolean } | null;
  /**
   * A completed freeform drop. `nodeId` is the dragged revision; `drop` names what it landed on —
   * a card (`targetIsHead` is whether that card is a CURRENT head, per the `AppState` this module
   * was attached with, so main.ts can offer merge without re-deriving it) or a parent link. `mode`
   * is the modifier state at the instant of the drop (`⌥`/Alt held = `"single"`, the splice), and
   * `at` is the drop's client position, for positioning the merge/move popover.
   *
   * Called AFTER the drag has fully unwound (transform reset, classes cleared, pointer capture
   * released), exactly like `onRepointDrop` — so a handler is free to re-render synchronously.
   */
  onFreeformDrop(
    nodeId: string,
    drop: { kind: "node"; targetId: string; targetIsHead: boolean } | { kind: "edge"; from: string; to: string },
    mode: "chain" | "single",
    at: { x: number; y: number },
  ): void;
  isEnabled(): boolean;
  /** Called synchronously the instant a drag starts (true) and again once it fully ends —
   * successful drop, revert, or cancel (false, deferred one macrotask so any click the browser
   * synthesizes right after `pointerup` has already been dispatched — see the module doc comment).
   * main.ts uses this to defer/flush incoming "state" re-renders while a card holds pointer
   * capture. */
  onDragActiveChange(active: boolean): void;
  /**
   * Live edge-follow (bug fix): called at most once per animation frame while a card is being
   * dragged (rAF-throttled below — a raw pointermove firehose recomputing SVG `d` strings on every
   * event would be too hot), and once more, synchronously with `(id, 0, 0)`, the instant the drag
   * ends (see `endDrag`) so the edges snap back in lockstep with the origin wrapper's own transform
   * reset rather than staying visually drifted until the next full re-render.
   *
   * `id` is the DRAGGED WRAPPER's own node id (`card.dataset.nodeId` — same value render.ts sets on
   * both the card and its `.alx-node` wrapper), NOT necessarily `originId`: a repoint drag started
   * on a ghost card has `originId === nodeId`, but the two are modeled separately because the
   * repoint gesture's subject (a missing revision id) is not in general the same thing as the
   * wrapper that's visually moving. `dxCanvas`/`dyCanvas` are the same zoom-divided deltas already
   * applied to that wrapper's CSS transform (see the module doc comment's Task 19 zoom note), so
   * main.ts can feed them straight into metrics.ts's `nodeAnchor` override without any further
   * conversion.
   */
  onDragMove(id: string, dxCanvas: number, dyCanvas: number): void;
}

const DRAG_THRESHOLD_PX = 4;
/** Offset of the cursor-following hint pill from the pointer, in client pixels (both axes) — far
 * enough that the pill never sits under the cursor itself. */
const HINT_OFFSET_PX = 14;

type DragKind = "freeform" | "repoint";

interface DragState {
  pointerId: number;
  kind: DragKind;
  /** freeform: the dragged revision's own id. repoint: the ghost (missing revision) id being
   * repaired — see the module doc comment on `[data-repoint-ghost-id]`. Either way, this is the
   * first argument of the eventual `onFreeformDrop`/`onRepointDrop` call, and (freeform) the
   * `originId` the uxMath validity predicates are asked about. */
  originId: string;
  /** The dragged WRAPPER's own node id (`card.dataset.nodeId`) — equal to `originId` for both
   * kinds today, but kept distinct because it answers a different question: this is what render.ts's
   * edge `data-from`/`data-to` attributes and metrics.ts's layout lookups key on, so it (not
   * `originId`) is always the correct id to pass to `onDragMove`. */
  nodeId: string;
  originCard: HTMLElement;
  originWrapper: HTMLElement;
  originZIndex: string;
  startX: number;
  startY: number;
  dragging: boolean;
  targetCard: HTMLElement | null;
  /** repoint only: every card ringed as a valid drop target at drag-start (see the module doc
   * comment's third design difference), so they can all be un-ringed on end. Always empty for a
   * freeform drag, which rings via `freeformCards` instead. */
  repointTargets: HTMLElement[];
  // ---- freeform only (all left at their defaults for a repoint drag) ----
  /** Live modifier state, re-sampled from `e.altKey` on every pointermove and decided finally at
   * pointerup: `"chain"` moves the node with its descendants, `"single"` (⌥/Alt) splices just the
   * node out and re-parents it alone. Drives the rings, the hint text, and the posted op. */
  mode: "chain" | "single";
  /** `getFreeformInfo`'s descendant walk, as a Set for the per-frame validity predicates. */
  descendantIds: Set<string>;
  /** Revisions a chain move would carry (the hint pill's count). */
  chainCount: number;
  /** Whether the dragged revision is a merge (chain-moving it dissolves its other parents — named
   * in the hint pill). */
  isMergeNode: boolean;
  /** Whether the dragged revision is a current head. Carried so the whole `getFreeformInfo` answer
   * lives in one place; the head-on-head merge choice itself is main.ts's call at drop time (it
   * owns the layout), not this module's. */
  isHeadNode: boolean;
  /** Every non-origin revision card, ringed valid/invalid at drag start and re-ringed whenever
   * `mode` flips — kept as a list so `endDrag` un-rings exactly what it ringed. */
  freeformCards: HTMLElement[];
  /** The `.alx-edge-hit` twin currently under the pointer (null when a card is the target, or
   * nothing is) — mutually exclusive with `targetCard`. */
  targetEdgeHit: SVGElement | null;
  /** The body-appended cursor-following hint pill, for the life of this drag. */
  hintEl: HTMLElement | null;
}

/**
 * Attaches freeform/repoint drag handling to `viewport` (the `.alx-canvas-viewport` element — a
 * fresh one every render, per render.ts, so this must be called again after every re-render, same
 * as main.ts's scroll listener). `state` supplies the current head ids, used only to tell
 * `onFreeformDrop` whether the card a revision was dropped on is a head (the merge-or-move
 * decision). `zoom` is the canvas's current scale factor (Task 19) — see the module doc comment's
 * zoom note for why the drag translate divides by it.
 */
export function attachDnd(viewport: HTMLElement, state: AppState, zoom: number, cb: DndCallbacks): void {
  const headIds = new Set(state.heads.map((h) => h.id));
  let drag: DragState | null = null;
  let suppressNextClick = false;

  // Live edge-follow throttling (see DndCallbacks.onDragMove's doc comment): pointermove fires far
  // more often than a frame renders, so only the LATEST delta per animation frame is ever forwarded
  // to the (potentially non-trivial: DOM query + metrics recompute + setAttribute per affected path)
  // callback. `dragMoveRaf` is cancelled in `endDrag` so a frame that was already scheduled right
  // before the drag ended can never fire late with a now-stale `drag` (or none at all).
  let dragMoveRaf: number | null = null;
  let dragMoveDx = 0;
  let dragMoveDy = 0;

  function scheduleDragMove(dxCanvas: number, dyCanvas: number): void {
    dragMoveDx = dxCanvas;
    dragMoveDy = dyCanvas;
    if (dragMoveRaf !== null) return;
    dragMoveRaf = requestAnimationFrame(() => {
      dragMoveRaf = null;
      if (!drag || !drag.dragging) return;
      cb.onDragMove(drag.nodeId, dragMoveDx, dragMoveDy);
    });
  }

  /** Every real revision card in the canvas (ghost/collapse cards use different classes and are
   * never `.alx-card`), excluding `exclude` — the drag origin itself for a freeform drag, and a
   * no-op exclusion for a ghost origin, which never has the `.alx-card` class to begin with. NOT
   * filtered by any validity rule: the repoint branch rings all of them (see the module doc
   * comment), and the freeform branch rings them valid-or-invalid via `applyFreeformRings`. */
  function revisionCards(exclude: HTMLElement): HTMLElement[] {
    return Array.from(viewport.querySelectorAll<HTMLElement>(".alx-card[data-node-id]")).filter(
      (el) => el !== exclude,
    );
  }

  /** The VISIBLE `.alx-edge` path for the same parent link as `hit` (its invisible fat-stroked
   * twin): both carry identical `data-from`/`data-to`, and `:not(.alx-edge-hit)` is what picks the
   * drawn one — the twin has no stroke of its own to highlight (see graph.css). */
  function visibleEdgeTwin(hit: SVGElement): SVGPathElement | null {
    const from = hit.dataset.from;
    const to = hit.dataset.to;
    if (!from || !to) return null;
    return viewport.querySelector<SVGPathElement>(
      `path[data-from="${CSS.escape(from)}"][data-to="${CSS.escape(to)}"]:not(.alx-edge-hit)`,
    );
  }

  /** (Re-)rings every non-origin revision card for the CURRENT mode — called at drag start and
   * again on every ⌥/Alt flip, since `single` mode legalizes the origin's own descendants. */
  function applyFreeformRings(d: DragState): void {
    for (const card of d.freeformCards) {
      const id = card.dataset.nodeId;
      const valid = id !== undefined && isValidFreeformNodeTarget(id, d.originId, d.mode, d.descendantIds);
      card.classList.toggle("alx-card--freeform-target", valid);
      card.classList.toggle("alx-card--invalid-target", !valid);
    }
  }

  /** Moves the single edge highlight to `hit` (or clears it) — a no-op when nothing changed, so
   * the common "pointer still over the same edge" frame does no DOM work at all. */
  function setEdgeTarget(d: DragState, hit: SVGElement | null): void {
    if (hit === d.targetEdgeHit) return;
    if (d.targetEdgeHit) visibleEdgeTwin(d.targetEdgeHit)?.classList.remove("alx-edge--drop-target");
    d.targetEdgeHit = hit;
    if (hit) visibleEdgeTwin(hit)?.classList.add("alx-edge--drop-target");
  }

  function updateHint(d: DragState, clientX: number, clientY: number): void {
    if (!d.hintEl) return;
    let text = dragHintText(d.mode, d.chainCount, d.isMergeNode);
    if (d.targetEdgeHit) {
      const from = d.targetEdgeHit.dataset.from ?? "";
      const to = d.targetEdgeHit.dataset.to ?? "";
      text += ` · insert between ${from.slice(0, 8)} and ${to.slice(0, 8)}`;
    }
    d.hintEl.textContent = text;
    // `position: fixed` (graph.css) — client coordinates go straight in, with no scroll or zoom
    // conversion, which is exactly why the pill lives outside the scaled canvas.
    d.hintEl.style.left = `${clientX + HINT_OFFSET_PX}px`;
    d.hintEl.style.top = `${clientY + HINT_OFFSET_PX}px`;
  }

  /**
   * What the pointer is over right now, for a freeform drag. Walks `elementsFromPoint`'s topmost-
   * first stack, skipping the dragged wrapper (it follows the cursor, so it is always the top hit)
   * and anything outside this viewport (toolbar, detail panel, the drop popover), and takes the
   * FIRST element that resolves to either a valid card target or a valid `.alx-edge-hit` twin.
   * Cards win over edges wherever both are hit, since a card sits above the edge layer. An INVALID
   * card is not a hit at all — it doesn't stop the scan — matching the rings' "this one says no"
   * reading rather than pretending the drop landed somewhere.
   */
  function freeformHitTest(
    d: DragState,
    clientX: number,
    clientY: number,
  ): { card: HTMLElement | null; edge: SVGElement | null } {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      if (d.originWrapper.contains(el)) continue;
      const card = el.closest<HTMLElement>(".alx-card[data-node-id]");
      if (card && viewport.contains(card)) {
        const id = card.dataset.nodeId;
        if (id !== undefined && isValidFreeformNodeTarget(id, d.originId, d.mode, d.descendantIds)) {
          return { card, edge: null };
        }
        continue;
      }
      if (el instanceof SVGElement && el.classList.contains("alx-edge-hit") && viewport.contains(el)) {
        const from = el.dataset.from;
        const to = el.dataset.to;
        if (from && to && isValidFreeformEdgeTarget(from, to, d.originId, d.mode, d.descendantIds)) {
          return { card: null, edge: el };
        }
      }
    }
    return { card: null, edge: null };
  }

  function endDrag(revert: boolean): void {
    if (!drag) return;
    const wasDragging = drag.dragging;
    if (dragMoveRaf !== null) {
      cancelAnimationFrame(dragMoveRaf);
      dragMoveRaf = null;
    }
    if (revert) {
      drag.originWrapper.style.transform = "";
      drag.originWrapper.style.zIndex = drag.originZIndex;
      // Bug fix: snap the edges back to the unmodified layout in lockstep with the transform reset
      // above — a (0, 0) delta recomputes each affected path from `drag.nodeId`'s plain,
      // unoverridden position, exactly matching what render.ts would draw. Covers every exit path
      // (drop, Escape/cancel revert) since `revert` is always true at every current call site; only
      // guarded on `wasDragging` because a click that never crossed the drag threshold never called
      // `onDragMove` in the first place, so there's nothing to restore.
      if (wasDragging) cb.onDragMove(drag.nodeId, 0, 0);
    }
    drag.originCard.classList.remove("alx-card--dragging");
    if (drag.kind === "repoint") {
      for (const c of drag.repointTargets) c.classList.remove("alx-card--repoint-target");
    } else {
      for (const c of drag.freeformCards) {
        c.classList.remove("alx-card--freeform-target", "alx-card--invalid-target");
      }
      setEdgeTarget(drag, null);
      drag.hintEl?.remove();
      drag.hintEl = null;
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
    const card = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-repoint-ghost-id], .alx-card[data-node-id]",
    );
    if (!card || !viewport.contains(card)) return;
    const wrapper = card.closest<HTMLElement>(".alx-node");
    if (!wrapper) return;

    let kind: DragKind;
    let originId: string;
    let nodeId: string;
    const ghostId = card.dataset.repointGhostId;
    const cardNodeId = card.dataset.nodeId;
    // Ghost first: only ghost cards carry `data-repoint-ghost-id` now, and they carry no `.alx-card`
    // class, so the two branches are disjoint however the combined selector above matched.
    if (ghostId !== undefined) {
      if (!ghostId || !cardNodeId) return;
      kind = "repoint";
      originId = ghostId;
      nodeId = cardNodeId;
    } else {
      if (!cardNodeId) return;
      kind = "freeform";
      originId = cardNodeId;
      nodeId = cardNodeId;
    }

    drag = {
      pointerId: e.pointerId,
      kind,
      originId,
      nodeId,
      originCard: card,
      originWrapper: wrapper,
      originZIndex: wrapper.style.zIndex,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      targetCard: null,
      repointTargets: [],
      mode: "chain",
      descendantIds: new Set(),
      chainCount: 1,
      isMergeNode: false,
      isHeadNode: false,
      freeformCards: [],
      targetEdgeHit: null,
      hintEl: null,
    };
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (drag.kind === "freeform") {
        // Asked exactly once, BEFORE anything is mutated, so a `null` answer (not actually
        // draggable) unwinds the pending drag without ever having captured the pointer, ringed a
        // card, or told main.ts a drag was active — `endDrag` with `dragging` still false is silent.
        const info = cb.getFreeformInfo(drag.nodeId);
        if (!info) {
          endDrag(true);
          return;
        }
        drag.mode = e.altKey ? "single" : "chain";
        drag.descendantIds = new Set(info.descendantIds);
        drag.chainCount = info.chainCount;
        drag.isMergeNode = info.isMerge;
        drag.isHeadNode = info.isHead;
      }
      drag.dragging = true;
      drag.originCard.setPointerCapture(drag.pointerId);
      drag.originCard.classList.add("alx-card--dragging");
      // Important fix (Task 19 review, finding 2): defensively clear any leftover FLIP transition
      // (flip.ts sets `transition: transform 200ms ease` on a node it just animated into place —
      // normally cleared on transitionend/timeout, but this belt-and-suspenders wipe means even a
      // pathological case where that cleanup hasn't fired yet can't make THIS drag's per-frame
      // translate()s below ease toward the cursor instead of tracking it 1:1.
      drag.originWrapper.style.transition = "";
      drag.originWrapper.style.zIndex = "60";
      document.addEventListener("keydown", onKeyDown);
      if (drag.kind === "repoint") {
        drag.repointTargets = revisionCards(drag.originCard);
        for (const c of drag.repointTargets) c.classList.add("alx-card--repoint-target");
      } else {
        drag.freeformCards = revisionCards(drag.originCard);
        applyFreeformRings(drag);
        // Body-appended (see the module doc comment): a re-render replaces the canvas subtree
        // wholesale, and while renders are deferred for the whole drag anyway, the pill has no
        // business living somewhere that could take it down.
        const hint = document.createElement("div");
        hint.className = "alx-drag-hint";
        document.body.append(hint);
        drag.hintEl = hint;
      }
      cb.onDragActiveChange(true);
    }

    e.preventDefault();
    // Divide by zoom: see the module doc comment's Task 19 note — dx/dy are raw client-pixel
    // deltas, but the wrapper sits inside a `transform: scale(zoom)` ancestor.
    const dxCanvas = dx / zoom;
    const dyCanvas = dy / zoom;
    drag.originWrapper.style.transform = `translate(${dxCanvas}px, ${dyCanvas}px)`;
    // Bug fix: keep the edges attached to this node tracking the card live, rAF-throttled (see
    // `scheduleDragMove`'s doc comment) rather than staying frozen at the pre-drag position until
    // the drag ends.
    scheduleDragMove(dxCanvas, dyCanvas);

    if (drag.kind === "repoint") {
      // Unchanged from Task 15: every valid repoint target is already ringed (set above, once, at
      // drag-start) — this rect loop just tracks which one the pointer happens to be over right
      // now, for onPointerUp's drop decision.
      let hit: HTMLElement | null = null;
      for (const other of drag.repointTargets) {
        if (other === drag.originCard) continue;
        const rect = other.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          hit = other;
          break;
        }
      }
      drag.targetCard = hit;
      return;
    }

    // ⌥/Alt is sampled off every single move (there is no keydown/keyup listener for it): the
    // instant it flips, the rings must re-read, since `single` legalizes the origin's descendants.
    const mode: "chain" | "single" = e.altKey ? "single" : "chain";
    if (mode !== drag.mode) {
      drag.mode = mode;
      applyFreeformRings(drag);
    }
    const { card, edge } = freeformHitTest(drag, e.clientX, e.clientY);
    drag.targetCard = card;
    setEdgeTarget(drag, edge);
    updateHint(drag, e.clientX, e.clientY);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasDragging = drag.dragging;
    const kind = drag.kind;
    const originId = drag.originId;
    const targetId = drag.targetCard?.dataset.nodeId ?? null;
    // Read off the hit twin BEFORE endDrag clears the drag state.
    const edgeFrom = drag.targetEdgeHit?.dataset.from ?? null;
    const edgeTo = drag.targetEdgeHit?.dataset.to ?? null;
    // The FINAL modifier decision is the one held at release, not whatever the last pointermove
    // sampled — releasing ⌥ before letting go of the button means a chain move, and vice versa.
    const mode: "chain" | "single" = e.altKey ? "single" : "chain";
    const at = { x: e.clientX, y: e.clientY };
    if (wasDragging) suppressNextClick = true;
    endDrag(true);
    if (!wasDragging) return;

    if (kind === "repoint") {
      if (targetId) cb.onRepointDrop(originId, targetId);
      return;
    }
    if (targetId) {
      cb.onFreeformDrop(originId, { kind: "node", targetId, targetIsHead: headIds.has(targetId) }, mode, at);
    } else if (edgeFrom && edgeTo) {
      cb.onFreeformDrop(originId, { kind: "edge", from: edgeFrom, to: edgeTo }, mode, at);
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
