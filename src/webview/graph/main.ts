/**
 * Graph webview entry point. Task 9 replaces `render()` with real graph rendering — everything
 * else here (state subscription, ready handshake, toolbar wiring) is the plumbing later tasks
 * build on, so keep it intact.
 */
import "./graph.css";
import { onMessage, post } from "../shared/vscodeApi";
import type { AppState } from "../../protocol/messages";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("alembic graph webview: missing #app root element");
const app: HTMLElement = appRoot;

renderWaiting();

onMessage((msg) => {
  switch (msg.type) {
    case "state":
      render(msg.state);
      break;
    // "detail" / "selectNode" / "toast" / "busy" arrive starting Task 9+.
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

/**
 * Skeleton render: proves the round trip with a refresh button and a raw state dump. No
 * innerHTML — state carries file paths/docstrings pulled straight from user files, so every
 * node here is built via createElement/textContent instead of interpolating strings into markup.
 */
function render(state: AppState): void {
  app.replaceChildren();

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";

  const refreshButton = document.createElement("button");
  refreshButton.id = "refresh";
  refreshButton.textContent = "Refresh";
  refreshButton.addEventListener("click", () => post({ type: "refresh" }));
  toolbar.append(refreshButton);

  const dump = document.createElement("pre");
  dump.textContent = JSON.stringify(state, null, 2);

  app.append(toolbar, dump);
}
