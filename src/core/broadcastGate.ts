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
 * Delivering a stale `busy:false` is safe because busy messages carry a per-invocation `token`
 * and every token-keyed consumer matches on it: the webviews' busyOps sets (see `applyBusyMessage`
 * below) only ever delete the stale invocation's OWN entry, and the graph webview's drop guard
 * (dropGuardActive in webview/graph/main.ts) disarms only on the token its own drop posted with.
 * A same-named operation the current pipeline has genuinely in flight sits under a different
 * token and stays tracked, so a stale terminal message can neither re-enable controls mid-run nor
 * disarm a freshly-armed drop guard. A stale `busy:true` or `toast` has no such self-limiting
 * shape — over-eagerly showing a toast or greying out a button for a project the user already
 * switched away from would just sit there, so those stay gated.
 */
import type { HostToWebviewMessage } from "../protocol/messages";

export function shouldDeliverStale(msg: HostToWebviewMessage): boolean {
  return msg.type === "busy" && msg.active === false;
}

/**
 * The one shared implementation of "apply a busy message to a webview's busyOps set" (sidebar and
 * graph main.ts both call this): tracked by `token`, NOT by operation name — see the module doc
 * comment above and the `token` field's comment in protocol/messages.ts. Deleting a token that
 * was never added is deliberately a no-op: actions post a terminal `busy:false` on cancel/abort
 * paths where no `busy:true` was ever broadcast (see mergeHeadsAction in src/ui/actions.ts).
 */
export function applyBusyMessage(
  busyOps: Set<string>,
  msg: Extract<HostToWebviewMessage, { type: "busy" }>,
): void {
  if (msg.active) busyOps.add(msg.token);
  else busyOps.delete(msg.token);
}
