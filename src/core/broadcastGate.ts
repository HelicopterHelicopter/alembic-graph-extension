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
 * Delivering a stale `busy:false` anyway is safe in a way delivering a stale `busy:true` or
 * `toast` is not: clearing a busy flag can only ever over-eagerly RE-ENABLE something, and that
 * self-corrects on its own even in the unlucky case where the new (current-epoch) pipeline has an
 * identically-named operation genuinely in flight — its own `busy:true`, already posted or about
 * to be, simply re-adds the flag moments later. Over-eagerly showing a toast or greying out a
 * button for a project the user already switched away from has no such self-correction, so those
 * stay gated.
 */
import type { HostToWebviewMessage } from "../protocol/messages";

export function shouldDeliverStale(msg: HostToWebviewMessage): boolean {
  return msg.type === "busy" && msg.active === false;
}
