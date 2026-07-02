/**
 * Sidebar webview entry point ("Alembic Migrations" activity-bar view). Simpler than the graph
 * webview: no persisted UI prefs, no client-side selection state — it's a pure re-render of
 * whatever `AppState` the host last posted (see sidebarView.ts), with a synchronous client-side
 * "empty" render up front (render.ts's renderEmpty()) that stands until (if ever) a real "state"
 * message arrives — see that function's doc comment for why this covers the no-project case too.
 */
import "./sidebar.css";
import { onMessage, post } from "../shared/vscodeApi";
import { render, renderEmpty, type Handlers } from "./render";

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

renderEmpty(app);

onMessage((msg) => {
  switch (msg.type) {
    case "state":
      render(app, msg.state, handlers);
      break;
    // "detail" / "selectNode" / "toast" / "busy" are graph-webview-only; the sidebar has no UI
    // that reacts to them.
    default:
      break;
  }
});

post({ type: "ready", restored: null });
