/**
 * The drop-time choice popover (freeform-topology task): a tiny menu shown where a drag was
 * released when the drop itself is ambiguous. Exactly one caller today — main.ts's
 * `onFreeformDrop`, for a head dropped onto another head, which could equally mean "merge these two
 * heads" or "move this chain under that one" — so this module is deliberately dumb: it renders
 * labels, calls the picked callback, and disappears. It knows nothing about revisions, busy state,
 * or messages (main.ts re-checks the busy/drop gate inside each `onPick` — a popover can sit open
 * indefinitely while the world moves on).
 *
 * The DOM/dismiss mechanics are cloned from contextMenu.ts (same `alx-menu`/`alx-menu-item` classes,
 * same measure-then-clamp positioning, same body append so a canvas re-render can't take it down,
 * createElement/textContent only — never innerHTML). What is NOT cloned is that module's
 * attach-once-per-render listener bookkeeping: this popover's dismiss listeners live only as long as
 * the popover does.
 */
export interface DropChoiceItem {
  label: string;
  onPick(): void;
}

/** The single open popover, if any — module-level so a second `openDropChoice` replaces the first
 * rather than stacking. */
let choiceEl: HTMLElement | null = null;
/** Tears down the open popover's own document listeners; null whenever nothing is open. */
let detachListeners: (() => void) | null = null;

function closeChoice(): void {
  if (detachListeners) {
    detachListeners();
    detachListeners = null;
  }
  if (!choiceEl) return;
  choiceEl.remove();
  choiceEl = null;
}

/**
 * Opens a popover at `at` (client coordinates — the drop point), one row per item, clamped so it
 * never overflows the window. Picking a row closes the popover and then runs `onPick`; Escape or a
 * click anywhere outside closes it having run nothing at all, which is the "I didn't mean either of
 * these" answer and must stay side-effect-free (no message posted, no drop guard armed).
 */
export function openDropChoice(at: { x: number; y: number }, items: DropChoiceItem[]): void {
  closeChoice();

  const menu = document.createElement("div");
  menu.className = "alx-menu";
  // Measured off-screen first (same trick as contextMenu.ts) so offsetWidth/offsetHeight reflect
  // real layout before the clamped position is computed.
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.visibility = "hidden";

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "alx-menu-item";
    row.textContent = item.label;
    row.addEventListener("click", () => {
      closeChoice();
      item.onPick();
    });
    menu.append(row);
  }

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const margin = 4;
  menu.style.left = `${Math.max(margin, Math.min(at.x, window.innerWidth - rect.width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(at.y, window.innerHeight - rect.height - margin))}px`;
  menu.style.visibility = "visible";
  choiceEl = menu;

  const onDocClick = (e: MouseEvent): void => {
    if (menu.contains(e.target as Node)) return; // a row's own listener already handled it
    closeChoice();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") closeChoice();
  };
  // Attached one macrotask late, deliberately: this popover is opened from inside a `pointerup`
  // handler, and the browser synthesizes a `click` immediately afterwards. dnd.ts already swallows
  // that click (its capture-phase `suppressNextClick` listener), but relying on that from here
  // would couple this module to the drag machine's internals — waiting a tick means no click that
  // belongs to the gesture which OPENED the popover can possibly be the one that closes it.
  const timer = setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
  }, 0);
  detachListeners = () => {
    clearTimeout(timer);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKeyDown);
  };
}
