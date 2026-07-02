/**
 * Graph webview entry point. Owns the small client-side store (current AppState + locally
 * selected id) and wires host <-> webview messaging to render.ts. Detail-panel consumption of
 * "select" (Task 10) and persistence of restored UI prefs (Task 11) build on this file without
 * needing structural changes here.
 */
import "./graph.css";
import { onMessage, post } from "../shared/vscodeApi";
import type { AppState, RevisionDetail } from "../../protocol/messages";
import { render, showToast, type Handlers, type ViewState } from "./render";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("alembic graph webview: missing #app root element");
const app: HTMLElement = appRoot;

const store: {
  state: AppState | null;
  selectedId: string | null;
  detail: RevisionDetail | null;
  detailOpen: boolean;
} = { state: null, selectedId: null, detail: null, detailOpen: false };

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

renderWaiting();

onMessage((msg) => {
  switch (msg.type) {
    case "state":
      store.state = msg.state;
      renderStore();
      break;
    case "detail":
      // Guard against a stale response for a selection the user has since moved on from (the
      // protocol carries no request id — a non-null detail is self-describing via its own `id`,
      // so drop it if it no longer matches the current selection; a null response has no id to
      // check, so it's accepted unconditionally, same as the synchronous real host: VS Code's
      // webview message channel is FIFO in both directions and GraphPanelManager's "select" case
      // has no async gap, so responses land in request order there — this guard only matters for
      // a host (or the dev harness) whose response timing could ever reorder).
      if (msg.detail === null || msg.detail.id === store.selectedId) {
        store.detail = msg.detail;
        renderStore();
      }
      break;
    case "toast":
      showToast(msg.level, msg.text);
      break;
    // "selectNode" / "busy" arrive starting Task 11+.
    default:
      break;
  }
});

post({ type: "ready", restored: null });

function renderWaiting(): void {
  app.replaceChildren();
  const waiting = document.createElement("p");
  waiting.textContent = "waiting for data…";
  app.append(waiting);
}

/** Re-renders from the current store, preserving the canvas scroll position across the rebuild
 * (render() replaces the canvas DOM wholesale on every call). */
function renderStore(): void {
  if (!store.state) return;
  const viewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  const scrollTop = viewport?.scrollTop ?? 0;
  const scrollLeft = viewport?.scrollLeft ?? 0;

  const view: ViewState = { selectedId: store.selectedId, detail: store.detail, detailOpen: store.detailOpen };
  render(app, store.state, view, handlers);

  const nextViewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  if (nextViewport) {
    nextViewport.scrollTop = scrollTop;
    nextViewport.scrollLeft = scrollLeft;
  }
}
