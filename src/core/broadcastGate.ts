/**
 * Pure predicate deciding whether a broadcast from a superseded (project-switched-away-from)
 * pipeline's epoch should still be delivered, despite `extension.ts`'s epoch gate having judged
 * the whole pipeline stale. Extracted so it's independently vitest-testable — the `broadcast`
 * closure in extension.ts can't be unit-tested directly (module-scope `import * as vscode` makes
 * the whole file unloadable outside a real extension host), same reasoning as
 * actionHelpers.ts/actions.ts.
 *
 * Terminal `busy: {active:false}` is the ONE exception to "a stale pipeline's messages are silent
 * no-ops": every CLI-backed action posts `busy:true` synchronously, then awaits the CLI call, then
 * posts `busy:false` in a `finally` (see actions.ts). If the user runs "Select Alembic Project…"
 * mid-await, the epoch bump lands between those two posts — `busy:true` made it into the old
 * epoch's sidebar/panel, but the matching `busy:false` that undoes it gets silently dropped right
 * along with it. Nothing else ever un-disables the affected button/drag-gate for the rest of the
 * session: the sidebar view is never torn down on a project switch (`SidebarViewProvider` rebinds
 * in place — see its doc comment), so its `busyOps` Set (webview/sidebar/main.ts) just stays stuck
 * with that operation's name in it forever, no self-heal short of a full window reload.
 *
 * Delivering a stale `busy:false` anyway is NOT a full fix — it trades the "wedged forever" bug
 * for a smaller, self-limiting one. If the new (current-epoch) pipeline happens to have an
 * identically-named operation genuinely in flight when the stale `busy:false` lands, it will
 * transiently clear that operation's flag and re-enable the UI (button/drag-gate) for a moment
 * even though the NEW project's own action is still running — a real, if narrow, over-enable
 * window. It self-corrects rather than compounds: the new action's own terminal `busy:false`
 * hasn't been double-counted away (busyOps is a Set, not a counter), so its own `busy:true`
 * already re-added the flag, and its own eventual `busy:false` still clears it correctly once it
 * actually finishes. Only that direction (over-eagerly RE-ENABLING) is judged tolerable; a stale
 * `busy:true` or `toast` has no equivalent self-correction — over-eagerly showing a toast or
 * greying out a button for a project the user already switched away from would just sit there, so
 * those stay gated.
 */
import type { HostToWebviewMessage } from "../protocol/messages";

export function shouldDeliverStale(msg: HostToWebviewMessage): boolean {
  return msg.type === "busy" && msg.active === false;
}
