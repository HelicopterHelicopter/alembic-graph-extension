/**
 * Right-click context menu for revision cards (Task 17): `upgrade to`/`downgrade to`/
 * `preview SQL`/`copy id`/`open file`, targeting one specific revision (unlike the toolbar's
 * upgrade-to-heads and the detail panel's own file row) — and, since the freeform-topology task,
 * for parent LINKS too: right-clicking an edge offers the one thing an edge can do, "Remove link".
 * Delegated on the canvas viewport, same shape as dnd.ts's `attachDnd`/main.ts's
 * `attachScrollListener` — `attachContextMenu` is called again after every render (the viewport is
 * a fresh DOM node each time), so all per-render state lives in module-level variables instead of
 * being lost across calls; the one-time (non-viewport-scoped) `document` listeners are guarded to
 * attach exactly once.
 *
 * The menu element itself is appended to `document.body`, NOT into the rendered tree — render.ts
 * replaces the whole canvas subtree on every re-render (see its header comment), and a menu that
 * lived inside it would otherwise need special-casing there just to survive across re-renders.
 * Living outside that tree means the brief's "dismiss on state re-render" needs an explicit hook —
 * `closeContextMenu()`, called by main.ts on the re-renders that actually invalidate an open menu
 * (see its doc comment) — nothing about a re-render would otherwise touch the menu.
 *
 * Card-kind detection reuses render.ts's existing classes rather than adding new data attributes:
 * every card in the canvas (revision, ghost, collapse) carries `data-node-id`, but only a real
 * revision card carries the `alx-card` class (see render.ts's `buildRevisionCard` vs.
 * `buildGhostCard`/`buildCollapseCard`) — that's the one check this module needs to tell a REVISION
 * card apart from a ghost/collapse card. Edges are recognized the same way, off render.ts's own
 * attributes: the invisible `.alx-edge-hit` twin (the only pointer-hittable thing in the edge layer)
 * carries `data-from`/`data-to`/`data-edge-kind`.
 */
export interface MenuHandlers {
  onUpgradeTo(id: string): void;
  onDowngradeTo(id: string): void;
  onPreviewSql(id: string): void;
  onCopyId(id: string): void;
  onOpenFile(id: string): void;
  /** Freeform-topology task: cut the parent link `from -> to` (`from` is the parent/older side, per
   * render.ts's edge attributes) — main.ts posts it as a `remove-edge` topology edit. */
  onRemoveEdge(from: string, to: string): void;
}

interface MenuItemSpec {
  label: string;
  onClick: () => void;
}

/** A revision card's items, in display order. A `null` entry renders as the separator between
 * "Preview SQL" and "Copy revision id" (per the brief — "Reveal in sidebar" from the original plan
 * is deliberately dropped, see the Task 17 report). */
function buildCardItems(id: string, handlers: MenuHandlers): (MenuItemSpec | null)[] {
  return [
    { label: "Upgrade to this revision", onClick: () => handlers.onUpgradeTo(id) },
    { label: "Downgrade to this revision", onClick: () => handlers.onDowngradeTo(id) },
    { label: "Preview SQL", onClick: () => handlers.onPreviewSql(id) },
    null,
    { label: "Copy revision id", onClick: () => handlers.onCopyId(id) },
    { label: "Open file", onClick: () => handlers.onOpenFile(id) },
  ];
}

/**
 * An edge's single item. `missingParent` is true for a BROKEN link — one whose parent side is a
 * ghost rather than a real revision (layout.ts marks exactly those `kind: "broken"`, which
 * render.ts copies onto the hit twin as `data-edge-kind`) — and labels it as such, since "remove
 * this link" reads very differently when the thing on the other end doesn't exist: that's the
 * cut-the-dangling-reference repair, and it's the ONE case where removing a link is usually the
 * right answer rather than a destructive edit.
 */
function buildEdgeItems(from: string, to: string, missingParent: boolean, handlers: MenuHandlers): MenuItemSpec[] {
  const missing = missingParent ? "(missing) " : "";
  return [
    {
      label: `Remove link ${missing}${from.slice(0, 8)} → ${to.slice(0, 8)}`,
      onClick: () => handlers.onRemoveEdge(from, to),
    },
  ];
}

/** The single open menu, if any — module-level (not per-call) so it survives across the
 * re-attach-every-render pattern described in the header comment. */
let menuEl: HTMLElement | null = null;
/** The viewport `attachContextMenu` was most recently called with — read by the once-ever
 * `document`-level dismiss listeners to tell "inside the (one) live viewport, already handled by
 * its own delegated listener" apart from "elsewhere". */
let activeViewport: HTMLElement | null = null;
/** Guards the one-time `document` listener registration — see the header comment. */
let documentListenersAttached = false;

function closeMenu(): void {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
}

/** Dismisses the open menu (if any). main.ts calls this on the two re-render triggers that
 * actually invalidate an open menu: an incoming "state" push (cards may have moved or vanished)
 * and a "busy" operation starting (the menu's items must not stay clickable once the busy gate is
 * down). Deliberately NOT baked into `attachContextMenu` itself, even though that also runs once
 * per re-render: opening the menu right-click-selects its own card (see the contextmenu handler
 * below), and the async `detail` response to that selection triggers a re-render of its own
 * moments later — an unconditional close-on-attach would dismiss every menu right after it
 * opened. */
export function closeContextMenu(): void {
  closeMenu();
}

/** Task 19: whether a menu is currently open — hover.ts's ancestry highlight is suppressed while
 * true (per the brief, alongside dragging and active search). */
export function isContextMenuOpen(): boolean {
  return menuEl !== null;
}

function isRevisionCard(card: HTMLElement): boolean {
  return card.classList.contains("alx-card");
}

/** Builds and shows a menu of `items` (a `null` entry is a separator), positioned at
 * `(clientX, clientY)` and clamped so it never overflows the window. Closes (and replaces) any menu
 * already open — callers must have already called `closeMenu()`/relied on it being closed; kept
 * idempotent regardless. */
function openMenu(items: (MenuItemSpec | null)[], clientX: number, clientY: number): void {
  closeMenu();

  const menu = document.createElement("div");
  menu.className = "alx-menu";
  // Measured off-screen first (see below) so offsetWidth/offsetHeight reflect real layout before
  // the clamped position is computed.
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.visibility = "hidden";

  for (const item of items) {
    if (item === null) {
      const sep = document.createElement("div");
      sep.className = "alx-menu-separator";
      menu.append(sep);
      continue;
    }
    const el = document.createElement("div");
    el.className = "alx-menu-item";
    el.textContent = item.label;
    el.addEventListener("click", () => {
      item.onClick();
      closeMenu();
    });
    menu.append(el);
  }

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const margin = 4;
  const left = Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "visible";

  menuEl = menu;
}

/** Attaches right-click-to-open-context-menu handling to `viewport` (a fresh `.alx-canvas-viewport`
 * element on every render — call again after every re-render, same as `attachDnd`). `isEnabled` is
 * the webview's existing busy/drop-guard gate (dnd.ts's `DndCallbacks.isEnabled`) — while busy, a
 * right-click on a revision card only suppresses the browser's default menu, nothing else.
 *
 * `canEditTopology` is the edit-mode lock (UiPrefs.editLocked, inverted), and it gates ONLY the
 * edge branch: "Remove link" is a mutating topology edit reached from an unlabeled hit target, so
 * it belongs to the same family of gestures the lock guards. A revision card's menu is untouched
 * by it — every item there is a labeled command the lock deliberately leaves live, and since
 * locked is the DEFAULT state, gating the card menu on it would mean the graph normally opens with
 * no card menu at all. */
export function attachContextMenu(
  viewport: HTMLElement,
  isEnabled: () => boolean,
  canEditTopology: () => boolean,
  handlers: MenuHandlers,
): void {
  activeViewport = viewport;
  // No closeMenu() here — dismissal on re-render is main.ts's job via closeContextMenu(), scoped
  // to the re-renders that actually invalidate a menu (see closeContextMenu's doc comment).

  viewport.addEventListener("contextmenu", (e: MouseEvent) => {
    // This handler fully owns right-clicks inside the viewport — never let the event reach the
    // document-level dismiss listener below. That listener's contains(e.target) guard can't be
    // trusted for viewport events: the card branch re-renders the canvas mid-handler (the
    // synthetic select click), after which `activeViewport` is the NEW viewport while `e.target`
    // still sits in the OLD detached tree — the guard would misread "inside" as "elsewhere" and
    // close the menu the instant it opened.
    e.stopPropagation();
    const target = e.target as HTMLElement;

    // Edges first: an `.alx-edge-hit` twin is never inside a card (it lives in the `.alx-edges`
    // SVG layer), so the two branches are disjoint — but checking it first keeps that independent
    // of any future nesting, and an edge right-click must not fall into the card branch's
    // select-then-open flow (there is no card, and nothing to select).
    const edgeHit = target.closest<SVGElement>(".alx-edge-hit");
    if (edgeHit && viewport.contains(edgeHit)) {
      e.preventDefault();
      closeMenu();
      const from = edgeHit.dataset.from;
      const to = edgeHit.dataset.to;
      // Same busy/drop-guard gate as a card's menu — while an operation is in flight a right-click
      // on an edge only suppresses the browser's default menu. The edit-mode lock lands in exactly
      // the same place and reads the same way: locked, an edge right-click opens no menu at all
      // (the `closeMenu()` above has already dismissed any menu still standing).
      if (!isEnabled() || !canEditTopology() || !from || !to) return;
      openMenu(buildEdgeItems(from, to, edgeHit.dataset.edgeKind === "broken", handlers), e.clientX, e.clientY);
      return;
    }

    const card = target.closest<HTMLElement>("[data-node-id]");
    if (!card || !viewport.contains(card)) {
      // Right-click on empty canvas background: not a card at all — dismiss any open menu (the
      // brief's "contextmenu ... elsewhere") but leave the browser's own default menu alone; only
      // cards suppress it (see below).
      closeMenu();
      return;
    }

    e.preventDefault();
    closeMenu();
    if (!isRevisionCard(card) || !isEnabled()) {
      // Ghosts/collapse cards get no menu at all (still preventDefault'd, above); busy suppresses
      // a revision card's menu too — either way, nothing further to do.
      return;
    }

    const id = card.dataset.nodeId;
    if (!id) return; // defensive: render.ts always sets this on every real revision card

    // Select the card via the SAME path a real click would (render.ts's own `click` listener on
    // the card) rather than duplicating onSelect's side effects here — this also means the
    // resulting re-render (main.ts's onSelect -> renderStore()) happens synchronously, before
    // openMenu() below runs, so the fresh viewport it produces is already wired up (via this same
    // module's re-entrant attachContextMenu call) by the time this handler returns.
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));

    openMenu(buildCardItems(id, handlers), e.clientX, e.clientY);
  });

  // Dismiss on scroll — but only a scroll that actually MOVES the viewport relative to where it
  // sat when this render wired things up. renderStore() restores scrollTop/scrollLeft onto the
  // fresh viewport right before calling attachContextMenu, and Chromium delivers the scroll event
  // for that programmatic set ASYNCHRONOUSLY — after this listener is attached and (in the
  // right-click flow, whose synthetic select click triggers exactly such a re-render) after the
  // menu has opened. Without this guard that restore echo closes every menu a few ms after it
  // opens whenever the canvas isn't sitting at its default scroll position.
  let expectedScrollTop = viewport.scrollTop;
  let expectedScrollLeft = viewport.scrollLeft;
  viewport.addEventListener(
    "scroll",
    () => {
      if (viewport.scrollTop === expectedScrollTop && viewport.scrollLeft === expectedScrollLeft) return;
      expectedScrollTop = viewport.scrollTop;
      expectedScrollLeft = viewport.scrollLeft;
      closeMenu();
    },
    { passive: true },
  );

  if (documentListenersAttached) return;
  documentListenersAttached = true;

  // Right-click OUTSIDE the (one, ever-live) viewport — e.g. the toolbar or detail panel. Right-
  // clicks INSIDE the viewport never reach this listener at all (the delegated handler above
  // stopPropagation()s them — see its comment); the contains() check is only a belt-and-
  // suspenders guard in case a future listener re-dispatches one.
  document.addEventListener("contextmenu", (e: MouseEvent) => {
    if (activeViewport && activeViewport.contains(e.target as Node)) return;
    closeMenu();
  });

  // Any left click anywhere (a menu item's own listener already ran the handler + closeMenu()
  // before this bubbles here — see openMenu — so this is what covers "click elsewhere").
  document.addEventListener("click", () => {
    closeMenu();
  });

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMenu();
  });
}
