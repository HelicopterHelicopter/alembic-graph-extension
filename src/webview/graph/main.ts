/**
 * Graph webview entry point. Owns the small client-side store (current AppState + locally
 * selected id) and wires host <-> webview messaging to render.ts. Detail-panel consumption of
 * "select" (Task 10) and persistence of restored UI prefs (Task 11) build on this file without
 * needing structural changes here.
 */
import "./graph.css";
import { onMessage, post } from "../shared/vscodeApi";
import type { AppState } from "../../protocol/messages";
import { render, showToast, type Handlers, type ViewState } from "./render";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("alembic graph webview: missing #app root element");
const app: HTMLElement = appRoot;

const store: { state: AppState | null; selectedId: string | null } = { state: null, selectedId: null };

const handlers: Handlers = {
  onSelect(id) {
    store.selectedId = id;
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
};

renderWaiting();

onMessage((msg) => {
  switch (msg.type) {
    case "state":
      store.state = msg.state;
      renderStore();
      break;
    case "toast":
      showToast(msg.level, msg.text);
      break;
    // "detail" / "selectNode" / "busy" arrive starting Task 10+.
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

  const view: ViewState = { selectedId: store.selectedId };
  render(app, store.state, view, handlers);

  const nextViewport = document.querySelector<HTMLElement>(".alx-canvas-viewport");
  if (nextViewport) {
    nextViewport.scrollTop = scrollTop;
    nextViewport.scrollLeft = scrollLeft;
  }
}
