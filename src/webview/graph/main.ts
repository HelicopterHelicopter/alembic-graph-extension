/**
 * Graph webview entry point. Owns the small client-side store (current AppState + locally
 * selected id) and wires host <-> webview messaging to render.ts. Detail-panel consumption of
 * "select" (Task 10) and persistence/restore of UI prefs, selection, and scroll (Task 11) build
 * on this file without needing structural changes here.
 */
import "./graph.css";
import { onMessage, post, getPersisted, setPersisted } from "../shared/vscodeApi";
import type { AppState, RevisionDetail, UiPrefs } from "../../protocol/messages";
import { render, showToast, type Handlers, type ViewState } from "./render";
import { nodeSize, nodeXY } from "./metrics";
import { attachDnd, type DndCallbacks } from "./dnd";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("alembic graph webview: missing #app root element");
const app: HTMLElement = appRoot;

/**
 * Shape persisted via `vscode.setState`/`getState` (survives tab hide + window reload while the
 * panel's tab exists — see shared/vscodeApi.ts). All fields optional/independently defaulted on
 * read so this shape can grow (e.g. Task 19's zoom) without migrating old persisted state.
 */
interface PersistedUiState {
  order?: UiPrefs["order"];
  density?: UiPrefs["density"];
  expandCollapsed?: boolean;
  selectedId?: string | null;
  detailOpen?: boolean;
  scrollTop?: number;
  scrollLeft?: number;
}

const store: {
  state: AppState | null;
  selectedId: string | null;
  detail: RevisionDetail | null;
  detailOpen: boolean;
  /** Operations (per the "busy" message's `operation` field) currently running host-side —
   * non-empty disables drag start (dnd.ts's `isEnabled()`) and shows the toolbar's busy
   * indicator. Populated/drained by the "busy" case in onMessage below. */
  busyOps: Set<string>;
} = { state: null, selectedId: null, detail: null, detailOpen: false, busyOps: new Set() };

/**
 * True from the instant a drag exceeds the pointer-move threshold (dnd.ts) until it fully ends
 * (drop, revert, or cancel). While true, incoming "state" messages are stashed in `pendingState`
 * instead of triggering a re-render — render() rebuilds the canvas wholesale, which would orphan
 * the card currently holding pointer capture mid-drag. See `dndCallbacks.onDragActiveChange`.
 */
let dragActive = false;
/** Latest "state" message received while `dragActive` — applied the moment the drag ends. Only
 * ever holds at most one entry: a second stash while still dragging simply overwrites the first,
 * since only the newest state matters once we do re-render. */
let pendingState: AppState | null = null;

/**
 * Extra guard beyond `store.busyOps`, closing the narrow race between a drop posting "merge" and
 * the host's "busy" response: mergeHeadsAction (src/ui/actions.ts) shows an interactive
 * `showInputBox` BEFORE ever posting `busy:true`, so there's a real, human-timescale window after
 * a drop where `store.busyOps` is still empty and a second drag could start. Armed the instant a
 * drop fires; disarmed ONLY by a `busy` message with operation "merge" or "repoint" and
 * active:false — the drop's own transaction ending (Task 16 scoping; previously ANY busy/toast
 * message disarmed it, so an unrelated operation's toast — e.g. an upgrade finishing — could
 * reopen the double-drop race mid-window). The host now guarantees that terminal busy:false on
 * EVERY merge/repoint outcome, including a cancelled input box and pre-busy validation aborts
 * (see mergeHeadsAction/repointAction) — the generous fixed timeout below stays as a
 * belt-and-suspenders floor so a dropped message can never wedge dragging off forever.
 */
let dropGuardActive = false;
let dropGuardTimer: ReturnType<typeof setTimeout> | null = null;
const DROP_GUARD_TIMEOUT_MS = 30000;

function armDropGuard(): void {
  dropGuardActive = true;
  if (dropGuardTimer !== null) clearTimeout(dropGuardTimer);
  dropGuardTimer = setTimeout(() => {
    dropGuardTimer = null;
    dropGuardActive = false;
  }, DROP_GUARD_TIMEOUT_MS);
}

function clearDropGuard(): void {
  dropGuardActive = false;
  if (dropGuardTimer !== null) {
    clearTimeout(dropGuardTimer);
    dropGuardTimer = null;
  }
}

/** Last known canvas scroll position. The single source of truth `persist()` reads from — the
 * canvas DOM is torn down and rebuilt wholesale on every render(), so scroll can't be read lazily
 * at persist time without risking a just-detached element. Seeded from persisted state (if any)
 * at module load, then kept in sync by renderStore()'s preserve-scroll step and the throttled
 * scroll listener below. */
let lastScroll = { scrollTop: 0, scrollLeft: 0 };

/** Read once, synchronously, before any message can arrive. Non-null only when this exact
 * webview tab previously called `setPersisted`. */
const persisted = getPersisted<PersistedUiState>();
if (persisted) {
  store.selectedId = persisted.selectedId ?? null;
  store.detailOpen = persisted.detailOpen ?? false;
  lastScroll = { scrollTop: persisted.scrollTop ?? 0, scrollLeft: persisted.scrollLeft ?? 0 };
}

/** Flips true after the first "state" message is processed — gates the one-time restored-
 * selection reconciliation (guard existence, refetch detail) so it never re-runs on later state
 * updates. The store's order/density/expandCollapsed always mirror the last received
 * `state.ui` — the host remains authoritative for those after `ready`. */
let firstStateHandled = false;

const handlers: Handlers = {
  onSelect(id) {
    store.selectedId = id;
    // Clear the previous selection's detail immediately so a stale panel never hangs around
    // attached to the wrong card while the host's async response for the new id is in flight.
    store.detail = null;
    store.detailOpen = true;
    post({ type: "select", id });
    renderStore();
  },
  onToggleOrder(order) {
    post({ type: "setOrientation", order });
  },
  onToggleDensity(density) {
    post({ type: "setDensity", density });
  },
  onExpandCollapse() {
    post({ type: "expandCollapse" });
  },
  onCloseDetail() {
    // Design's `closeDetails`: hides the panel but leaves the card selection/highlight alone.
    store.detailOpen = false;
    renderStore();
  },
  onOpenFile(id) {
    post({ type: "openFile", id });
  },
};

/** dnd.ts's hooks into this store — see the module doc comments on `dragActive`/`dropGuardActive`
 * above for why each exists. */
const dndCallbacks: DndCallbacks = {
  isEnabled() {
    return store.busyOps.size === 0 && !dropGuardActive;
  },
  onMergeDrop(a, b) {
    armDropGuard();
    post({ type: "merge", a, b });
  },
  onRepointDrop(ghostId, targetId) {
    // Task 15: repointAction (host) has no interactive prompt like mergeHeadsAction's
    // showInputBox, so its terminal "busy" post follows almost immediately — but arming the same
    // guard here anyway costs nothing (it's disarmed by repoint's busy:false moments later) and
    // keeps this callback's shape identical to onMergeDrop's rather than special-casing one drag
    // kind.
    armDropGuard();
    post({ type: "repoint", ghostId, targetId });
  },
  onDragActiveChange(active) {
    dragActive = active;
    if (!active && pendingState !== null) {
      const next = pendingState;
      pendingState = null;
      applyState(next);
    }
  },
};

renderWaiting();

onMessage((msg) => {
  switch (msg.type) {
    case "state": {
      // Re-render guard (Task 14): a mid-drag DOM rebuild would orphan the card currently holding
      // pointer capture — stash and apply once the drag ends (dndCallbacks.onDragActiveChange).
      if (dragActive) {
        pendingState = msg.state;
        break;
      }
      applyState(msg.state);
      break;
    }
    case "detail":
      // Guard against a stale response for a selection the user has since moved on from.
      // `forId` names the id the response answers (null for a deselect), so one symmetric rule
      // covers both null and non-null: apply the message only if it still answers the current
      // selection. This matters even though VS Code's webview message channel is FIFO in both
      // directions and GraphPanelManager's "select" case has no async gap — a *later* select can
      // still be posted before an *earlier* select's response is handled, and without checking
      // `forId` a stale null response could wipe out a valid, newer detail (or vice versa).
      if (msg.forId === store.selectedId) {
        store.detail = msg.detail;
        renderStore();
      }
      break;
    case "toast":
      // Deliberately does NOT touch the drop guard (Task 16): an unrelated operation's toast
      // (e.g. an upgrade finishing) arriving inside the drop→busy window must not reopen the
      // double-drop race. The guard clears only on merge/repoint busy:false — see the "busy"
      // case below and dropGuardActive's doc comment.
      showToast(msg.level, msg.text);
      break;
    case "selectNode": {
      // Task 12: a click in the sidebar heads list routes here via GraphPanelManager.
      // revealAndSelect() — same selection side effects as clicking the card directly (onSelect
      // above), plus centering the canvas on the node since it may be scrolled out of view.
      store.selectedId = msg.id;
      store.detail = null;
      store.detailOpen = true;
      post({ type: "select", id: msg.id });
      renderStore();
      scrollNodeIntoView(msg.id);
      break;
    }
    case "busy": {
      // Drop-guard clearing is scoped (Task 16) to the two DRAG-initiated operations' terminal
      // busy:false — the definitive "that drop's host-side transaction is over" signal. While a
      // merge/repoint is actually running, busy:true keeps drags gated via store.busyOps anyway,
      // so not clearing on it loses nothing; an unrelated op's busy traffic (upgrade/sql/...)
      // must leave the guard alone entirely.
      if (!msg.active && (msg.operation === "merge" || msg.operation === "repoint")) {
        clearDropGuard();
      }
      if (msg.active) store.busyOps.add(msg.operation);
      else store.busyOps.delete(msg.operation);
      renderStore();
      break;
    }
    default:
      break;
  }
});

post({
  type: "ready",
  restored: persisted ? restoredPrefs(persisted) : null,
});

function renderWaiting(): void {
  app.replaceChildren();
  const waiting = document.createElement("p");
  waiting.textContent = "waiting for data…";
  app.append(waiting);
}

/** Applies a freshly-received (or drag-end-flushed) AppState: the one-time restored-selection
 * reconciliation, then a render. Split out of the "state" onMessage case so both the live
 * round-trip and the deferred-render flush (dndCallbacks.onDragActiveChange) share the exact same
 * logic. */
function applyState(state: AppState): void {
  const isFirstState = !firstStateHandled;
  firstStateHandled = true;
  store.state = state;

  // One-time restore reconciliation: only meaningful the first time we have a real layout to
  // check the persisted selectedId against.
  if (isFirstState && persisted && store.selectedId !== null) {
    const stillExists = state.layout.nodes.some((n) => n.id === store.selectedId);
    if (stillExists) {
      // Highlight applies for free (renderStore() below reads store.selectedId); refetch its
      // detail since the previous webview instance's fetched detail didn't survive.
      post({ type: "select", id: store.selectedId });
    } else {
      store.selectedId = null;
      store.detailOpen = false;
    }
  }

  renderStore();
}

/** Re-renders from the current store, preserving the canvas scroll position across the rebuild
 * (render() replaces the canvas DOM wholesale on every call) — falling back to the last known
 * (possibly restored) scroll when there's no existing viewport yet, i.e. on the very first
 * render. Persists the full UI-prefs/selection/detail/scroll snapshot after every render, which
 * covers order/density/expandCollapsed (mirrored from state.ui), selection, and detailOpen —
 * every change funnels through here except scroll-only movement (see attachScrollListener).
 *
 * Never called while `dragActive` (see the "state" case in onMessage and
 * dndCallbacks.onDragActiveChange) — render() rebuilds the canvas wholesale, which would orphan
 * the card currently holding pointer capture mid-drag. */
function renderStore(): void {
  if (!store.state) return;
  const viewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  const scrollTop = viewport?.scrollTop ?? lastScroll.scrollTop;
  const scrollLeft = viewport?.scrollLeft ?? lastScroll.scrollLeft;

  const view: ViewState = {
    selectedId: store.selectedId,
    detail: store.detail,
    detailOpen: store.detailOpen,
    busy: store.busyOps.size > 0,
  };
  render(app, store.state, view, handlers);

  const nextViewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  if (nextViewport) {
    nextViewport.scrollTop = scrollTop;
    nextViewport.scrollLeft = scrollLeft;
    lastScroll = { scrollTop, scrollLeft };
    attachScrollListener(nextViewport);
    // dnd.ts (Task 14): re-attach every render since the viewport (and every card in it) is a
    // fresh DOM subtree each time — same reason attachScrollListener above is re-run.
    attachDnd(nextViewport, store.state, dndCallbacks);
  }

  persist();
}

/** Scrolls the canvas viewport so `id`'s card is roughly centered — used by the "selectNode"
 * handler (Task 12) to bring a sidebar-selected node into view. Computes the target position from
 * the pure metrics.ts math (the same formulas render.ts's computePositions uses) rather than
 * querying the just-rendered DOM node's offset, so it works even for a node whose wrapper doesn't
 * expose its own position lookup. Must run AFTER renderStore() so `.alx-canvas-viewport` reflects
 * the current node/order/density layout and has a settled clientWidth/clientHeight to center
 * within. A no-op if `id` isn't a real layout node (e.g. a stale/unknown id) or the viewport isn't
 * in the DOM (state not yet rendered). */
function scrollNodeIntoView(id: string): void {
  if (!store.state) return;
  const node = store.state.layout.nodes.find((n) => n.id === id);
  const viewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  if (!node || !viewport) return;

  const { ui, layout } = store.state;
  const { x, y } = nodeXY(node, ui, layout.rowCount, ui.density);
  const { w, h } = nodeSize(node, ui.density);
  const scrollLeft = Math.max(0, x + w / 2 - viewport.clientWidth / 2);
  const scrollTop = Math.max(0, y + h / 2 - viewport.clientHeight / 2);

  viewport.scrollTo({ left: scrollLeft, top: scrollTop });
  lastScroll = { scrollTop, scrollLeft };
  persist();
}

let scrollPersistTimer: ReturnType<typeof setTimeout> | null = null;

/** Attaches a throttled (~250ms trailing) scroll listener to `viewport`. Scroll events don't
 * bubble, and the canvas (including the viewport element) is rebuilt wholesale on every render, so
 * this must be re-attached to the fresh element after every renderStore() call. Per the brief:
 * scrolling must NOT trigger a re-render — this only updates `lastScroll` + persists.
 *
 * The scheduled flush deliberately re-queries `.alx-canvas-viewport` from the document instead of
 * reading `viewport` (the parameter) at fire time: `scrollPersistTimer` is a single module-level
 * guard shared across every attachScrollListener() call, so a scroll event on an OLDER viewport
 * can still be the one that wins the "already scheduled" race and be the one whose timeout fires —
 * by which point a re-render may have replaced it in the DOM. A detached element's scrollTop is
 * not reliably its last live value (observed empirically: it reads back as 0), so closing over the
 * stale element and reading it 250ms later can silently persist a wrong scroll position. */
function attachScrollListener(viewport: HTMLElement): void {
  viewport.addEventListener("scroll", () => {
    if (scrollPersistTimer !== null) return; // a flush is already scheduled; it'll read the latest position
    scrollPersistTimer = setTimeout(() => {
      scrollPersistTimer = null;
      const current = document.querySelector<HTMLElement>(".alx-canvas-viewport");
      if (!current) return;
      lastScroll = { scrollTop: current.scrollTop, scrollLeft: current.scrollLeft };
      persist();
    }, 250);
  });
}

/** Writes the full persisted-state shape to `vscode.setState`, composed from the current store +
 * host-authoritative ui (from the last "state" message, if any) + last known scroll. */
function persist(): void {
  const ui = store.state?.ui;
  const snapshot: PersistedUiState = {
    order: ui?.order,
    density: ui?.density,
    expandCollapsed: ui?.expandCollapsed,
    selectedId: store.selectedId,
    detailOpen: store.detailOpen,
    scrollTop: lastScroll.scrollTop,
    scrollLeft: lastScroll.scrollLeft,
  };
  setPersisted(snapshot);
}

/** Narrows a persisted snapshot down to the `Partial<UiPrefs>` the `ready` handshake sends —
 * omitting (not just leaving `undefined`) any field the snapshot never populated, since spreading
 * an object with an explicit `undefined` value would otherwise clobber the host's corresponding
 * field in `applyUiPrefs`'s `{...base, ...prefs}` merge. */
function restoredPrefs(p: PersistedUiState): Partial<UiPrefs> {
  const out: Partial<UiPrefs> = {};
  if (p.order !== undefined) out.order = p.order;
  if (p.density !== undefined) out.density = p.density;
  if (p.expandCollapsed !== undefined) out.expandCollapsed = p.expandCollapsed;
  return out;
}
