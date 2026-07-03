/**
 * Host-side action handlers shared by the graph panel's message dispatch (src/ui/graphPanel.ts),
 * the sidebar's (src/ui/sidebarView.ts), and command-palette entry points (src/extension.ts) —
 * one seam so every call site runs the exact same guard/prompt/CLI/toast/refresh flow instead of
 * copies drifting apart.
 *
 * Golden rule (same one alembicCli.ts and migrationService.ts follow): a CLI-backed action must
 * degrade, never throw — a missing interpreter, a rejected prompt, or a broken revision chain all
 * end in a toast/log line, never an unhandled rejection back to VS Code or the webview.
 */
import * as vscode from "vscode";
import { bothAreCurrentHeads, mergeSuccessText, cliErrorText, repointSuccessText } from "./actionHelpers";
import { applyRepoint } from "../services/repoint";
import type { AlembicCli, RunResult } from "../services/alembicCli";
import type { MigrationService } from "../services/migrationService";
import type { HostToWebviewMessage } from "../protocol/messages";

export interface ActionContext {
  cli: AlembicCli;
  service: MigrationService;
  log: (line: string) => void;
  /** Posts to the graph panel AND the sidebar view — each a safe no-op when its webview isn't
   * currently open/resolved (see GraphPanelManager.postMessage / SidebarViewProvider.postMessage).
   * Renamed from Task 14/15's `postToPanel`: busy/toast now needs to reach both surfaces (e.g. the
   * sidebar's upgrade button must grey out while ANY operation — merge, repoint, upgrade, sql — is
   * running, not just its own); `state`/`detail`/`selectNode` messaging is untouched by this and
   * still goes through each webview's own dedicated push (see graphPanel.ts / sidebarView.ts). */
  broadcast: (msg: HostToWebviewMessage) => void;
}

/**
 * repointAction's dependencies — deliberately NOT `ActionContext`: unlike merge, a repoint never
 * touches `alembic` (there's no CLI for this — see core/repoint.ts's doc comment), so requiring a
 * live `AlembicCli` here would wrongly gate repoint's availability on Python/alembic being
 * configured at all.
 */
export type RepointActionContext = Pick<ActionContext, "service" | "log" | "broadcast">;

/**
 * Drag-to-merge / "Merge Heads…" command flow: validates both ids are current heads, prompts for
 * a merge message, runs `alembic merge -m <message> <a> <b>`, and schedules a refresh on success.
 * Never throws — every failure path (stale heads, a cancelled prompt, a CLI failure, or any
 * genuinely unexpected exception) degrades to a toast/log line and returns.
 */
export async function mergeHeadsAction(ctx: ActionContext, a: string, b: string): Promise<void> {
  try {
    const heads = ctx.service.getState()?.heads ?? [];
    if (!bothAreCurrentHeads(heads, a, b)) {
      ctx.broadcast({ type: "toast", level: "error", text: "Both revisions must be current heads to merge." });
      // The webview armed its drop guard the instant the drop posted "merge", and (Task 16) only
      // a merge/repoint `busy:false` disarms it — toasts no longer do. Send that definitive
      // "transaction over" signal even though `busy:true` was never broadcast (deleting an op that
      // was never added is a webview-side no-op), or an aborted drop would leave dragging locked
      // out for the guard's full 30s timeout.
      ctx.broadcast({ type: "busy", operation: "merge", active: false });
      ctx.log(`mergeHeadsAction: ${a} / ${b} are not both current heads — aborting`);
      return;
    }

    const message = await vscode.window.showInputBox({
      value: `merge heads ${a.slice(0, 8)} and ${b.slice(0, 8)}`,
      prompt: "Merge revision message",
    });
    if (message === undefined) {
      // Cancelled — still silent (no toast/log noise), but broadcast `busy:false` (Task 14 review
      // carry-over): a cancelled input box previously sent NOTHING back to the webview, leaving
      // its drop guard silently armed until the 30s timeout. Same never-added/no-op-delete note
      // as the abort path above.
      ctx.broadcast({ type: "busy", operation: "merge", active: false });
      return;
    }

    ctx.broadcast({ type: "busy", operation: "merge", active: true });
    try {
      const result: RunResult = await ctx.cli.run(["merge", "-m", message, a, b]);
      if (result.ok) {
        ctx.broadcast({ type: "toast", level: "success", text: mergeSuccessText(result.stdout, message) });
        ctx.service.scheduleRefresh();
      } else {
        ctx.broadcast({ type: "toast", level: "error", text: cliErrorText(result) });
        void vscode.window.showErrorMessage("alembic merge failed — see Alembic Graph output");
        ctx.log(`mergeHeadsAction: alembic merge failed: ${result.error}`);
      }
    } finally {
      ctx.broadcast({ type: "busy", operation: "merge", active: false });
    }
  } catch (err) {
    // Defensive only — every awaited call above is documented never-throw, but the same golden
    // rule (CLI-adjacent host actions degrade, never throw) applies to this function as a whole.
    ctx.log(`mergeHeadsAction: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Ghost-drag repoint drop flow: plans the edit set from the cached graph (cycle-guarded — see
 * MigrationService.getRepointPlan), applies it (services/repoint.ts's WorkspaceEdit-per-file text
 * surgery), and toasts the result. Unlike mergeHeadsAction there's no interactive prompt to
 * confirm — alembic has no CLI for this operation, so the drop itself is the only user gesture —
 * and no explicit `service.scheduleRefresh()` call on success: the file(s) `applyRepoint` saves
 * trip the same workspace file watcher a manual edit would, which schedules its own rescan. Never
 * throws — every failure path (an unknown/invalid plan, a text-surgery rejection, or a write
 * failure) degrades to a toast/log line and returns.
 */
export async function repointAction(ctx: RepointActionContext, ghostId: string, targetId: string): Promise<void> {
  try {
    const plan = ctx.service.getRepointPlan(ghostId, targetId);
    if (!plan.ok) {
      ctx.broadcast({ type: "toast", level: "error", text: plan.reason });
      // Same drop-guard release as mergeHeadsAction's abort path (see the comment there): the
      // webview armed its guard on drop, and only a merge/repoint busy:false disarms it now.
      ctx.broadcast({ type: "busy", operation: "repoint", active: false });
      ctx.log(`repointAction: ${ghostId} -> ${targetId}: ${plan.reason}`);
      return;
    }

    ctx.broadcast({ type: "busy", operation: "repoint", active: true });
    try {
      const result = await applyRepoint(plan.edits, ghostId, targetId);
      if (result.ok) {
        ctx.broadcast({ type: "toast", level: "success", text: repointSuccessText(targetId) });
      } else {
        ctx.broadcast({ type: "toast", level: "error", text: result.reason });
        void vscode.window.showErrorMessage("alembic graph: re-point failed — see Alembic Graph output");
        ctx.log(`repointAction: applyRepoint failed: ${result.reason}`);
      }
    } finally {
      ctx.broadcast({ type: "busy", operation: "repoint", active: false });
    }
  } catch (err) {
    // Defensive only, same golden rule as mergeHeadsAction's own catch — every awaited call above
    // is documented never-throw.
    ctx.log(`repointAction: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * DB-mutating upgrade flow (sidebar footer button, graph panel's `upgrade` message, and the
 * `alembicGraph.upgradeHead` command all land here). `target` is `"heads"` for the multi-head-safe
 * upgrade-all (plural — `head` errors when more than one head exists) or a specific revision id
 * (Task 17's upgradeTo). Because this is the first action that actually MODIFIES the user's
 * database, it opens with a modal confirmation offering three ways out: **Upgrade** (run it),
 * **Preview SQL** (hand off to previewSqlAction's offline dry run instead), or cancel/Escape
 * (silent return — no busy was ever broadcast, so there's nothing to clear; unlike merge/repoint
 * there's no webview drop guard armed for this flow either, since it starts from a button/command,
 * not a drag). Success refreshes via `service.refresh()` (NOT scheduleRefresh: no file changed, so
 * no watcher event is coming — and refresh's phase-2 enrichment is exactly what picks up the new
 * current/applied DB state). Never throws — same golden rule as every action above.
 */
export async function upgradeAction(ctx: ActionContext, target: string): Promise<void> {
  try {
    const choice = await vscode.window.showWarningMessage(
      `Run alembic upgrade ${target}? This modifies the database.`,
      { modal: true },
      "Upgrade",
      "Preview SQL",
    );
    if (choice === "Preview SQL") {
      await previewSqlAction(ctx, target);
      return;
    }
    if (choice !== "Upgrade") return; // cancelled — silent, nothing was ever broadcast

    ctx.broadcast({ type: "busy", operation: "upgrade", active: true });
    try {
      const result: RunResult = await ctx.cli.run(["upgrade", target]);
      if (result.ok) {
        ctx.broadcast({ type: "toast", level: "success", text: `Upgraded to ${target}` });
        void ctx.service.refresh();
      } else {
        ctx.broadcast({ type: "toast", level: "error", text: cliErrorText(result) });
        void vscode.window.showErrorMessage("alembic upgrade failed — see Alembic Graph output");
        ctx.log(`upgradeAction: alembic upgrade ${target} failed: ${result.error}`);
      }
    } finally {
      ctx.broadcast({ type: "busy", operation: "upgrade", active: false });
    }
  } catch (err) {
    // Defensive only, same golden rule as mergeHeadsAction's own catch — every awaited call above
    // is documented never-throw.
    ctx.log(`upgradeAction: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Offline SQL dry run: `alembic upgrade <to> --sql` emits the DDL it WOULD run as plain SQL on
 * stdout — offline mode never opens a DB connection (sqlite never even creates the db file; the
 * integration test in test/unit/alembicCli.test.ts proves that), so this is always safe to run,
 * no confirmation needed. The captured stdout opens in a fresh untitled `sql` editor
 * (`preview: false` so a follow-up action can't silently replace the tab). `to` is any upgrade
 * target alembic accepts (`"heads"` from Task 16's call sites; a specific id from Task 17's
 * context menu). Never throws — CLI failure degrades to an error toast + log, same as the rest.
 */
export async function previewSqlAction(ctx: ActionContext, to: string): Promise<void> {
  try {
    ctx.broadcast({ type: "busy", operation: "sql", active: true });
    try {
      const result: RunResult = await ctx.cli.run(["upgrade", to, "--sql"]);
      if (result.ok) {
        const doc = await vscode.workspace.openTextDocument({ language: "sql", content: result.stdout });
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        ctx.broadcast({ type: "toast", level: "error", text: cliErrorText(result) });
        void vscode.window.showErrorMessage("alembic upgrade --sql failed — see Alembic Graph output");
        ctx.log(`previewSqlAction: alembic upgrade ${to} --sql failed: ${result.error}`);
      }
    } finally {
      ctx.broadcast({ type: "busy", operation: "sql", active: false });
    }
  } catch (err) {
    // Not purely defensive here: openTextDocument/showTextDocument CAN reject (e.g. the window
    // closing mid-flight) — the same degrade-never-throw rule absorbs it, and the finally above
    // has already cleared busy by the time this runs.
    ctx.log(`previewSqlAction: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Per-revision DB-mutating downgrade flow (Task 17's context menu "Downgrade to this revision").
 * Unlike upgradeAction there's no Preview SQL escape hatch offered here — an offline downgrade
 * dry run needs a *range* (alembic's `downgrade --sql <from>:<to>`), not just a target, which is
 * out of scope for this modal (see the Task 17 brief) — so the confirmation is a single-button
 * "Downgrade" or cancel/Escape (silent, nothing was ever broadcast). `id` is always the FULL
 * revision id (the modal text and success toast truncate it to 8 chars for display only; the
 * actual `alembic downgrade` call always gets the full id). Never throws — same golden rule as
 * every action above.
 */
export async function downgradeToAction(ctx: ActionContext, id: string): Promise<void> {
  try {
    const short = id.slice(0, 8);
    const choice = await vscode.window.showWarningMessage(
      `Run alembic downgrade ${short}? This modifies the database.`,
      { modal: true },
      "Downgrade",
    );
    if (choice !== "Downgrade") return; // cancelled — silent, nothing was ever broadcast

    ctx.broadcast({ type: "busy", operation: "downgrade", active: true });
    try {
      const result: RunResult = await ctx.cli.run(["downgrade", id]);
      if (result.ok) {
        ctx.broadcast({ type: "toast", level: "success", text: `Downgraded to ${short}` });
        void ctx.service.refresh();
      } else {
        ctx.broadcast({ type: "toast", level: "error", text: cliErrorText(result) });
        void vscode.window.showErrorMessage("alembic downgrade failed — see Alembic Graph output");
        ctx.log(`downgradeToAction: alembic downgrade ${id} failed: ${result.error}`);
      }
    } finally {
      ctx.broadcast({ type: "busy", operation: "downgrade", active: false });
    }
  } catch (err) {
    // Defensive only, same golden rule as mergeHeadsAction's own catch — every awaited call above
    // is documented never-throw.
    ctx.log(`downgradeToAction: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** QuickPick label for newRevisionAction's autogenerate choice — a named constant (not inlined
 * twice) since both the QuickPick item itself and the branch that reacts to it need the exact
 * same string. */
const AUTOGENERATE_LABEL = "Autogenerate from models (--autogenerate)";

/**
 * `alembic revision -m <message> [--autogenerate]` flow (Task 17's toolbar "+ New revision"
 * button): prompts for a revision message, then asks empty-vs-autogenerate via QuickPick, runs
 * the CLI, and toasts the result. Both prompts degrade to a silent return on cancel/Escape —
 * nothing is broadcast until the QuickPick resolves, so unlike mergeHeadsAction there's no
 * drop-guard/busy state to clear on an early exit. Autogenerate failing (no configured
 * `env.py`/target metadata/DB) is the NORMAL failure mode for this button, not a rare edge case —
 * the error toast (cliErrorText's stderr excerpt) must stay legible for it, not just for a genuine
 * crash. Success schedules a refresh even though the new versions file landing on disk will also
 * trip the workspace file watcher on its own (belt-and-suspenders: scheduleRefresh is a cheap,
 * idempotent debounce, not a second real scan). Never throws — same golden rule as every action
 * above.
 */
export async function newRevisionAction(ctx: ActionContext): Promise<void> {
  try {
    const message = await vscode.window.showInputBox({
      prompt: "New revision message",
      placeHolder: "add products table",
      validateInput: (value) => (value.trim().length === 0 ? "Revision message is required" : undefined),
    });
    if (message === undefined) return; // cancelled — silent

    const choice = await vscode.window.showQuickPick(["Empty revision", AUTOGENERATE_LABEL], {
      placeHolder: "Revision type",
    });
    if (choice === undefined) return; // cancelled — silent

    const args = ["revision", "-m", message];
    if (choice === AUTOGENERATE_LABEL) args.push("--autogenerate");

    ctx.broadcast({ type: "busy", operation: "revision", active: true });
    try {
      const result: RunResult = await ctx.cli.run(args);
      if (result.ok) {
        ctx.broadcast({ type: "toast", level: "success", text: "Revision created" });
        ctx.service.scheduleRefresh();
      } else {
        ctx.broadcast({ type: "toast", level: "error", text: cliErrorText(result) });
        void vscode.window.showErrorMessage("alembic revision failed — see Alembic Graph output");
        ctx.log(`newRevisionAction: alembic revision failed: ${result.error}`);
      }
    } finally {
      ctx.broadcast({ type: "busy", operation: "revision", active: false });
    }
  } catch (err) {
    // Defensive only, same golden rule as mergeHeadsAction's own catch — every awaited call above
    // is documented never-throw.
    ctx.log(`newRevisionAction: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
