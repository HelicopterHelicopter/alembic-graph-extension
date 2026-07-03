/**
 * FLIP (First-Last-Invert-Play) layout transitions for the canvas (Task 19, point 4). render.ts
 * rebuilds `.alx-canvas-viewport` wholesale on every renderStore() call (see its header comment),
 * so there's no persistent DOM to animate in place — instead this module snapshots each node's
 * position from the OLD viewport right before render() replaces it (`captureFlipSnapshot`), then
 * diffs against the FRESH viewport's positions right after (`playFlip`) and fakes the movement
 * with a transform that eases back to identity. New nodes (present after but not before) fade in;
 * removed nodes need nothing — they're simply absent from the fresh DOM.
 *
 * Reads/writes only `.style.left/top/transform/opacity/transition` — never touches render.ts's
 * layout math, and runs entirely after render() + main.ts's scroll restore, so it can't affect
 * either. Skips all animation under `prefers-reduced-motion: reduce`, landing directly on final
 * (already-correct, since render.ts always draws the real target state) positions/opacity.
 */

export interface FlipSnapshot {
  positions: Map<string, { left: number; top: number }>;
}

/** Call BEFORE render() replaces the canvas — reads `.alx-node[data-node-id]` positions off the
 * about-to-be-discarded DOM. Returns null when there's no previous canvas at all (first-ever
 * render), which `playFlip`/`playEdgesFade` treat as "nothing to animate from". */
export function captureFlipSnapshot(viewport: HTMLElement | null): FlipSnapshot | null {
  if (!viewport) return null;
  const positions = new Map<string, { left: number; top: number }>();
  for (const el of viewport.querySelectorAll<HTMLElement>(".alx-node[data-node-id]")) {
    const id = el.dataset.nodeId;
    if (!id) continue;
    positions.set(id, { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 });
  }
  return { positions };
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Call AFTER render() has produced the fresh `viewport` — diffs its node positions against
 * `previous` and animates the difference away (200ms ease, transform only) for nodes present in
 * both; fades new nodes in (opacity 0->1, 150ms). No-op (final state stands, nothing to undo)
 * under reduced-motion or when `previous` is null.
 */
export function playFlip(viewport: HTMLElement | null, previous: FlipSnapshot | null): void {
  if (!viewport || !previous || prefersReducedMotion()) return;

  const moved: { el: HTMLElement; dx: number; dy: number }[] = [];
  const entered: HTMLElement[] = [];

  for (const el of viewport.querySelectorAll<HTMLElement>(".alx-node[data-node-id]")) {
    const id = el.dataset.nodeId;
    if (!id) continue;
    const prev = previous.positions.get(id);
    if (!prev) {
      entered.push(el);
      continue;
    }
    const left = parseFloat(el.style.left) || 0;
    const top = parseFloat(el.style.top) || 0;
    const dx = prev.left - left;
    const dy = prev.top - top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved.push({ el, dx, dy });
  }
  if (moved.length === 0 && entered.length === 0) return;

  // "First"/inverted state: jump straight to where the old element was (or invisible, for a new
  // node) with no transition yet.
  for (const { el, dx, dy } of moved) {
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  for (const el of entered) {
    el.style.transition = "none";
    el.style.opacity = "0";
  }

  // Force a layout flush so the browser commits the "First" styles above as their own frame —
  // without this it can coalesce both writes into one paint and skip the transition entirely.
  void viewport.offsetHeight;

  requestAnimationFrame(() => {
    for (const { el } of moved) {
      el.style.transition = "transform 200ms ease";
      el.style.transform = "";
      clearInlineTransitionWhenSettled(el, "transform");
    }
    for (const el of entered) {
      el.style.transition = "opacity 150ms ease";
      el.style.opacity = "1";
      clearInlineTransitionWhenSettled(el, "opacity");
    }
  });
}

/**
 * Important fix (Task 19 review, finding 2): `el.style.transition` set above is never otherwise
 * cleared, so it lingers on the (still-live — this IS the fresh, current canvas, not a discarded
 * one; see this module's header comment) `.alx-node` wrapper indefinitely, i.e. until the NEXT
 * render() rebuilds the canvas from scratch. If a drag starts on that node before then, dnd.ts's
 * per-frame `translate()` writes land on an element that still carries `transition: transform
 * 200ms ease` — the browser eases toward each new pointer position instead of snapping to it
 * immediately, so the dragged card visibly lags the cursor. Clears the inline `transition` (and any
 * leftover `transform`, belt-and-suspenders — `moved`'s callers already reset it to `""` above, but
 * `entered`'s opacity-only path never touched `transform` to begin with) on the transition actually
 * finishing, with a fixed timeout as a safety net in case `transitionend` never fires (e.g. the
 * element is detached by a re-render before the transition completes, or a browser quirk drops the
 * event) — either path is idempotent and safe to run twice.
 */
function clearInlineTransitionWhenSettled(el: HTMLElement, property: "transform" | "opacity"): void {
  let cleared = false;
  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    el.style.transition = "";
  };
  el.addEventListener(
    "transitionend",
    (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === property) clear();
    },
    { once: true },
  );
  setTimeout(clear, 250);
}

/** Fades `.alx-edges` in over 150ms on any re-render after the first (no path morphing — a
 * crossfade instead, per the brief). No-op under reduced-motion or when this IS the first render
 * (`hasPrevious` false — nothing to fade from, and nothing should flash on initial paint). */
export function playEdgesFade(viewport: HTMLElement | null, hasPrevious: boolean): void {
  if (!viewport || !hasPrevious || prefersReducedMotion()) return;
  const svg = viewport.querySelector<SVGSVGElement>(".alx-edges");
  if (!svg) return;

  svg.style.transition = "none";
  svg.style.opacity = "0";
  void svg.getBoundingClientRect();

  requestAnimationFrame(() => {
    svg.style.transition = "opacity 150ms ease";
    svg.style.opacity = "1";
  });
}
