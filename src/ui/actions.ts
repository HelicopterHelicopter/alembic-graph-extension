/**
 * Host-side action handlers shared by the graph panel's message dispatch (src/ui/graphPanel.ts)
 * and command-palette entry points (src/extension.ts) — one seam so both call sites run the exact
 * same guard/prompt/CLI/toast/refresh flow instead of two copies drifting apart.
 *
 * Golden rule (same one alembicCli.ts and migrationService.ts follow): a CLI-backed action must
 * degrade, never throw — a missing interpreter, a rejected prompt, or a broken revision chain all
 * end in a toast/log line, never an unhandled rejection back to VS Code or the webview.
 */
import * as vscode from "vscode";
import { bothAreCurrentHeads, mergeSuccessText, mergeErrorText, repointSuccessText } from "./actionHelpers";
import { applyRepoint } from "../services/repoint";
import type { AlembicCli, RunResult } from "../services/alembicCli";
import type { MigrationService } from "../services/migrationService";
import type { HostToWebviewMessage } from "../protocol/messages";

export interface ActionContext {
  cli: AlembicCli;
  service: MigrationService;
  log: (line: string) => void;
  /** Post to the graph panel if open; no-op otherwise (see GraphPanelManager.postMessage). */
  postToPanel: (msg: HostToWebviewMessage) => void;
}

/**
 * repointAction's dependencies — deliberately NOT `ActionContext`: unlike merge, a repoint never
 * touches `alembic` (there's no CLI for this — see core/repoint.ts's doc comment), so requiring a
 * live `AlembicCli` here would wrongly gate repoint's availability on Python/alembic being
 * configured at all.
 */
export type RepointActionContext = Pick<ActionContext, "service" | "log" | "postToPanel">;

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
      ctx.postToPanel({ type: "toast", level: "error", text: "Both revisions must be current heads to merge." });
      ctx.log(`mergeHeadsAction: ${a} / ${b} are not both current heads — aborting`);
      return;
    }

    const message = await vscode.window.showInputBox({
      value: `merge heads ${a.slice(0, 8)} and ${b.slice(0, 8)}`,
      prompt: "Merge revision message",
    });
    if (message === undefined) return; // cancelled — silently return, no toast/log noise

    ctx.postToPanel({ type: "busy", operation: "merge", active: true });
    try {
      const result: RunResult = await ctx.cli.run(["merge", "-m", message, a, b]);
      if (result.ok) {
        ctx.postToPanel({ type: "toast", level: "success", text: mergeSuccessText(result.stdout, message) });
        ctx.service.scheduleRefresh();
      } else {
        ctx.postToPanel({ type: "toast", level: "error", text: mergeErrorText(result) });
        void vscode.window.showErrorMessage("alembic merge failed — see Alembic Graph output");
        ctx.log(`mergeHeadsAction: alembic merge failed: ${result.error}`);
      }
    } finally {
      ctx.postToPanel({ type: "busy", operation: "merge", active: false });
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
      ctx.postToPanel({ type: "toast", level: "error", text: plan.reason });
      ctx.log(`repointAction: ${ghostId} -> ${targetId}: ${plan.reason}`);
      return;
    }

    ctx.postToPanel({ type: "busy", operation: "repoint", active: true });
    try {
      const result = await applyRepoint(plan.edits, ghostId, targetId);
      if (result.ok) {
        ctx.postToPanel({ type: "toast", level: "success", text: repointSuccessText(targetId) });
      } else {
        ctx.postToPanel({ type: "toast", level: "error", text: result.reason });
        void vscode.window.showErrorMessage("alembic graph: re-point failed — see Alembic Graph output");
        ctx.log(`repointAction: applyRepoint failed: ${result.reason}`);
      }
    } finally {
      ctx.postToPanel({ type: "busy", operation: "repoint", active: false });
    }
  } catch (err) {
    // Defensive only, same golden rule as mergeHeadsAction's own catch — every awaited call above
    // is documented never-throw.
    ctx.log(`repointAction: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
