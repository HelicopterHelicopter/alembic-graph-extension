/**
 * Sidebar webview entry point ("Alembic Migrations" activity-bar view). Simpler than the graph
 * webview: no persisted UI prefs, no client-side selection state — it's a pure re-render of
 * whatever `AppState` the host last posted (see sidebarView.ts), with a synchronous client-side
 * "scanning" render up front (render.ts's renderScanning()) that stands until either a real
 * "state" message arrives (real project, scan complete) or a "noProject" message arrives (host
 * confirmed no alembic.ini exists) — see those functions' doc comments.
 *
 * Task 16: also tracks host-side busy operations (the "busy" message, broadcast to both webviews
 * — see ActionContext.broadcast in src/ui/actions.ts) so the footer's upgrade button is disabled
 * while ANY action (merge, repoint, upgrade, sql) is in flight — a second `alembic upgrade`
 * queued behind a running one via AlembicCli's FIFO mutex would otherwise fire with no visible
 * warning that one is already running.
 */
import "./sidebar.css";
import { onMessage, post } from "../shared/vscodeApi";
import { render, renderScanning, renderNoProject, type Handlers } from "./render";
import type { AppState } from "../../protocol/messages";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("alembic sidebar webview: missing #app root element");
const app: HTMLElement = appRoot;

/** Last received AppState — kept so a "busy" flip can re-render without waiting for the host to
 * push state again (busy messages deliberately don't carry state). */
let lastState: AppState | null = null;
/** Host-side operations currently in flight — same shape as the graph webview's store.busyOps. */
const busyOps = new Set<string>();

const handlers: Handlers = {
  onSelect(id) {
    post({ type: "select", id });
  },
  onUpgrade() {
    // Belt-and-suspenders with the disabled styling (render.ts adds pointer-events:none via the
    // --disabled class): a synthesized/programmatic click while busy must not post either.
    if (busyOps.size > 0) return;
    post({ type: "upgrade" });
  },
};

function renderCurrent(): void {
  if (lastState) render(app, lastState, handlers, busyOps.size > 0);
}

renderScanning(app);

onMessage((msg) => {
  switch (msg.type) {
    case "state":
      lastState = msg.state;
      renderCurrent();
      break;
    case "noProject":
      renderNoProject(app);
      break;
    case "busy":
      if (msg.active) busyOps.add(msg.operation);
      else busyOps.delete(msg.operation);
      // No-op until the first "state" lands — the scanning/no-project placeholders have no
      // upgrade button to disable.
      renderCurrent();
      break;
    // "detail" / "selectNode" / "toast" are graph-webview-only; the sidebar has no UI that
    // reacts to them.
    default:
      break;
  }
});

post({ type: "ready", restored: null });
