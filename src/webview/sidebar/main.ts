/**
 * Sidebar webview entry point ("Alembic Migrations" activity-bar view). Simpler than the graph
 * webview: no persisted UI prefs, no client-side selection state — it's a pure re-render of
 * whatever `AppState` the host last posted (see sidebarView.ts), with a synchronous client-side
 * "scanning" render up front (render.ts's renderScanning()) that stands until either a real
 * "state" message arrives (real project, scan complete) or a "noProject" message arrives (host
 * confirmed no alembic.ini exists) — see those functions' doc comments.
 */
import "./sidebar.css";
import { onMessage, post } from "../shared/vscodeApi";
import { render, renderScanning, renderNoProject, type Handlers } from "./render";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("alembic sidebar webview: missing #app root element");
const app: HTMLElement = appRoot;

const handlers: Handlers = {
  onSelect(id) {
    post({ type: "select", id });
  },
  onUpgrade() {
    post({ type: "upgrade" });
  },
};

renderScanning(app);

onMessage((msg) => {
  switch (msg.type) {
    case "state":
      render(app, msg.state, handlers);
      break;
    case "noProject":
      renderNoProject(app);
      break;
    // "detail" / "selectNode" / "toast" / "busy" are graph-webview-only; the sidebar has no UI
    // that reacts to them.
    default:
      break;
  }
});

post({ type: "ready", restored: null });
