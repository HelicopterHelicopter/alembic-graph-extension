# Broken-Link Blame + Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the graph shows a ghost (missing `down_revision` target), automatically find via git history either the commit that deleted the missing revision (→ one-click Restore) or the commit that introduced the broken reference on a branch where the parent never existed (cherry-pick case → one-click Import from the ref that has it).

**Architecture:** A new `gitDeletion.ts` service (injected-exec, cached, never-throws — mirrors `gitAuthor.ts`) implements a two-mode search; `MigrationService` fires it as a third generation-guarded async enrichment whose result rides `AppState.ghostBlame`; the webview renders one hint-style line + button under ghost cards; a `restoreDeletedAction` in `actions.ts` (standard never-throw/busy-finally shape) runs `git restore --source=…`.

**Tech Stack:** TypeScript, vitest (injected-exec unit tests + real-git tmp-dir integration tests), Playwright harness for webview verification.

**Spec:** docs/superpowers/specs/2026-07-07-broken-link-blame-design.md (binding; read it first).

## Global Constraints

- `src/core/*` stays pure (no vscode/node imports; compiles under both tsconfigs). `gitDeletion.ts` lives in `src/services/` (node allowed, no vscode import — vitest-testable like `alembicCli.ts`).
- All postMessage payloads JSON-serializable; repo root NEVER crosses postMessage (carried inside the service/action context).
- Webview rendering: createElement/textContent only; static styles as graph.css classes; theme tokens `--alx-*`; busy-gated affordances.
- Actions: never throw; `busy(op,true/false)` with false in `finally`; error toasts via `cliErrorText`-style excerpts + `showErrorMessage`.
- Enrichments: generation-guarded (mirror `fetchAuthors` in `migrationService.ts`); a stale batch must be discarded; re-emits compose with prior enrichments.
- Tests never mutate checked-in fixtures — tmp-dir copies/scratch repos only, cleaned in afterAll, `skipIf` git missing.

---

### Task B1: gitDeletion service + ghostBlame enrichment + diagnostics enrichment

**Files:**
- Create: `src/services/gitDeletion.ts`
- Create: `test/unit/gitDeletion.test.ts`
- Modify: `src/protocol/messages.ts` (AppState + GhostBlame type)
- Modify: `src/services/migrationService.ts` (third enrichment)
- Modify: `src/core/diagnostics.ts` + `test/unit/diagnostics.test.ts` (blame-enriched broken-link message)
- Modify: `src/extension.ts` (wire `fetchGhostBlame` dep)
- Modify: `test/unit/migrationService.test.ts` (enrichment tests)

**Interfaces:**
- Consumes: `parseRevisionSource` (src/core/parser.ts), `ExecFn`-style injected exec (copy the shape from `src/services/alembicCli.ts`), `MigrationGraph.ghosts` (`{id, childIds}[]`), graph node `filePath` for the ghost's first child.
- Produces (binding for Task B2):
```ts
// src/protocol/messages.ts
export type GhostBlame =
  | { kind: "deleted-here"; commit: string; shortCommit: string; author: string; date: string; subject: string; deletedFilePath: string }
  | { kind: "never-existed"; introducedCommit: string; introducedShortCommit: string; introducedAuthor: string;
      introducedDate: string; introducedSubject: string; cherryPickedFrom: string | null;
      foundOn: { ref: string; commit: string; filePath: string } | null };
// AppState gains: ghostBlame: Record<string, GhostBlame | null>;   // {} until enrichment lands
// src/services/gitDeletion.ts
export interface GhostBlameProvider {
  lookup(requests: { missingId: string; childFilePath: string }[]): Promise<Record<string, GhostBlame | null>>;
  /** Repo root captured at first successful git call; used later by the restore action. */
  getRepoRoot(): string | null;
  clearCache(): void;
}
export function createGhostBlameProvider(opts: { versionsDir: string; log: (l: string) => void; exec?: ExecFn }): GhostBlameProvider;
// migrationService deps gains: fetchGhostBlame?: (requests: {missingId, childFilePath}[]) => Promise<Record<string, GhostBlame | null>>;
```

- [ ] **Step 1: Write failing unit tests for the search algorithm** (`test/unit/gitDeletion.test.ts`, injected exec — fake `git` responses keyed by argv). Cover: (a) deletion pickaxe hit with NUL-format parse (`%H%x00%an%x00%aI%x00%s` + `--name-status` D lines) → verification via `git show <sha>^:<path>` whose content defines `revision = '<id>'` → `kind:"deleted-here"` with all fields incl. shortCommit = first 8; (b) verification REJECT: pre-image parses to a different revision id (a deleted referencer) → falls through; (c) fallback glob path when pickaxe empty; (d) never-existed: deletion search empty → `--diff-filter=A -- <childFilePath>` introduction commit parsed (with `%B` body containing `(cherry picked from commit abcdef…)` → `cherryPickedFrom` sha; body without it → null); `git log --all -S… --diff-filter=A` hit verified via `git show <sha>:<path>` defining the id → `foundOn` with ref from `git branch -a --contains` first line; (e) `--all` search empty → `foundOn: null`; (f) git exec failure/not-a-repo → `{ [id]: null }`, never throws; (g) cache: second lookup for the same id → zero exec calls; clearCache resets; (h) two ghosts in one lookup → sequential (reuse the mutex-free simple loop; no concurrency needed — document).
- [ ] **Step 2: Run to verify RED** — `npx vitest run test/unit/gitDeletion.test.ts` → module-not-found / assertion failures. Capture output.
- [ ] **Step 3: Implement `src/services/gitDeletion.ts`** per the spec algorithm (pickaxe → verify → glob fallback → introduction+--all fallback), `getRepoRoot()` via `git rev-parse --show-toplevel` (cached), per-id cache, every git call through the injected exec with cwd = versionsDir, all failures → null entries + one log line each.
- [ ] **Step 4: GREEN** — `npx vitest run test/unit/gitDeletion.test.ts` all passing.
- [ ] **Step 5: Protocol + enrichment.** Add `GhostBlame` + `AppState.ghostBlame` (default `{}` in `doRefresh`). In `migrationService.ts`, mirror the `fetchAuthors` enrichment verbatim-in-shape: when `graph.ghosts.length > 0` and `deps.fetchGhostBlame` exists, fire after the static emit with `{missingId: g.id, childFilePath: nodes[g.childIds[0]].filePath}` requests; generation-guard; merge into state (`ghostBlame`) + single re-emit composing with prior enrichments. Failing tests first in `test/unit/migrationService.test.ts`: (a) enrichment lands → second emit with ghostBlame populated, layout object otherwise intact; (b) stale generation discarded; (c) no ghosts → fetchGhostBlame never called; (d) rejection → logged, no emit.
- [ ] **Step 6: Diagnostics enrichment.** `buildFileDiagnostics(problems)` gains an optional second param `ghostBlame?: Record<string, GhostBlame | null>`; for `broken-down-revision` problems whose missingId (revisionIds[1]) has a `deleted-here` blame, append ` — deleted in <shortCommit> by <author>`; `never-existed` → ` — never in this branch's history (introduced in <introducedShortCommit>)`. Update `src/services/diagnostics.ts` call site to pass `state.ghostBlame`. Failing tests first in `test/unit/diagnostics.test.ts` (both kinds + absent → unchanged message).
- [ ] **Step 7: Wire extension.ts** — build one `GhostBlameProvider` per pipeline (beside `createAuthorProvider`), `deps.fetchGhostBlame = (reqs) => provider.lookup(reqs)`; `clearCache()` on project switch (same place authorProvider is reset); keep the provider reachable for Task B2's action (export via the Pipeline object like `cli`).
- [ ] **Step 8: Real-git integration tests** (in `gitDeletion.test.ts`, `describe.skipIf` git missing): scratch repo in `os.tmpdir()` — (a) commit healthy-fixture versions files, commit 2 deletes one → `lookup` returns `deleted-here` with commit-2 sha + path; (b) two-branch repo: branch A adds parent then child (two commits); branch B from base cherry-picks ONLY the child commit with `-x` → on B, `lookup` → `never-existed`, `cherryPickedFrom` = A's child sha, `foundOn.commit` on A defining the parent; then `git restore --source=<foundOn.commit> -- <foundOn.filePath>` on B → file exists and `parseRevisionSource` gives the missing id. rm -rf in afterAll.
- [ ] **Step 9: Full verification** — `npm run test:unit` (all suites), `npm run check`, `npm run build` clean.
- [ ] **Step 10: Commit** — `git commit -m "feat: add git blame for missing revisions (deleted-here and never-existed modes)"`

### Task B2: Ghost-card blame UI + Restore/Import action

**Files:**
- Modify: `src/protocol/messages.ts` (`{type:"restoreFile", ghostId}` webview→host; busy op union gains `"restore"`)
- Modify: `src/webview/graph/render.ts` + `graph.css` (ghost blame line + button)
- Modify: `src/webview/graph/main.ts` (handler wiring; busy gating)
- Modify: `src/ui/actions.ts` (+ `test/unit/actions.test.ts` for any pure helper) — `restoreDeletedAction`
- Modify: `src/ui/graphPanel.ts` (restoreFile case; exhaustiveness guard will force it)
- Modify: `src/extension.ts` (pass provider into the ActionContext or a narrowed restore context)
- Modify: `harness/graph.html` (seed ghostBlame; record restoreFile posts), `docs/manual-test.md`, `README.md` (one feature line)

**Interfaces:**
- Consumes from B1: `GhostBlame` union, `AppState.ghostBlame`, `GhostBlameProvider.getRepoRoot()`.
- Produces: `restoreDeletedAction(ctx: ActionContext & { blameProvider: GhostBlameProvider }, ghostId: string): Promise<void>` (exact modal copy in the spec's Restore action section — use it verbatim).

- [ ] **Step 1: Failing Playwright-facing render checks first where unit-testable** — extract `ghostBlameLineText(blame: GhostBlame): { text: string; button: "Restore" | "Import" | null; tooltip: string }` as a pure function in `src/webview/graph/render.ts`'s sibling (or `uxMath.ts`-style module) with vitest: `deleted-here` → `deleted in <shortCommit> · <author> · <date.slice(0,10)>` + button "Restore" + tooltip subject; `never-existed`+foundOn → `never in this branch · introduced by <author> in <shortCommit> (cherry-pick) · parent on <ref>` (" (cherry-pick)" only when cherryPickedFrom) + "Import"; without foundOn → suffix `— fetch the source branch or drag to re-point`, button null. RED → implement → GREEN.
- [ ] **Step 2: Render the line** under ghost cards (same absolute top-100%+4px pattern/classes as the broken-hint; button is a small `.alx-ghost-restore-btn` class, pointer-events auto, rest of the block none; busy-disabled like other affordances). Click → `post({type:"restoreFile", ghostId})`. Nothing renders when blame pending/null.
- [ ] **Step 3: Host action.** `restoreDeletedAction` per the spec section verbatim (blame lookup from `service.getState().ghostBlame`, kind-based source `--source=<commit>^ -- <deletedFilePath>` vs `--source=<foundOn.commit> -- <foundOn.filePath>`, exists-guard via `getRepoRoot()`+fs, modal copy per spec, `busy("restore")` in finally, execFile git at repo root, success/failure toasts). graphPanel `restoreFile` case → action. Extension wiring.
- [ ] **Step 4: Verification** — `npm run check` + `npm run build` + `npm run test:unit` clean. Playwright on the harness: seed a `deleted-here` blame → line renders with Restore, click posts `{type:"restoreFile", ghostId:"deadbeef0000"}`; seed `never-existed`+foundOn → Import; without foundOn → no button; busy(restore,true) disables; pending (absent key) → no line. Screenshot → `.superpowers/sdd/task-b2-screenshot.png`.
- [ ] **Step 5: docs/manual-test.md "Blame + restore" section** (F5 broken fixture is NOT a git-deleted case — its ghost will show `never-existed` or null depending on this repo's history; document what to expect and how to stage a real deleted-here demo: delete a fixture revision file in a scratch git repo). README feature line.
- [ ] **Step 6: Commit** — `git commit -m "feat: show deletion blame on ghost cards with one-click restore/import"`

## Self-Review (done)
- Spec coverage: search both modes (B1 s1-4), enrichment (B1 s5), diagnostics (B1 s6), UI line per kind (B2 s1-2), restore/import action + modal copy (B2 s3), integration incl. cherry-pick repo (B1 s8), Playwright (B2 s4). ✓
- No placeholders; signatures match across tasks (`GhostBlame`, `lookup(requests)`, `getRepoRoot`, `restoreFile`). ✓
- Type consistency: `ghostBlame` name used identically in protocol/service/diagnostics/webview. ✓
