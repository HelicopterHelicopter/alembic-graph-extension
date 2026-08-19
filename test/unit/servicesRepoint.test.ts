/**
 * `applyDownRevisionEdits`' phase-1 STALENESS GUARD (src/services/repoint.ts): the check that the
 * file on disk/in the buffer still says what the plan was built from, before anything is written.
 *
 * WHY THIS FILE BREAKS THE CONVENTION. Every other suite here tests the pure half of a
 * vscode-coupled module and leaves the module itself alone — `test/unit/actions.test.ts` states the
 * rule and the reason at the top of the file: `vscode` is a host-injected module that does not
 * resolve outside a real extension host, so importing `ui/actions.ts` or `services/repoint.ts` used
 * to fail the whole test file at load time. That rule is right for ORCHESTRATION code, where a
 * mock would only re-assert the shape of the mock. The staleness guard is not orchestration: it is
 * the single decision standing between a stale plan and a silently clobbered buffer, it lives
 * INSIDE the vscode-coupled loop (so no pure helper can reach it end to end), and the property that
 * matters most about it — that a rejection writes NOTHING, not even the files that were still
 * valid — is only observable by witnessing that `workspace.applyEdit` was never called. That is
 * exactly what a mock can witness and a pure test cannot.
 *
 * WHAT THE MOCK COVERS: the minimum `vscode` surface phases 1–3 touch — `Uri.file`,
 * `workspace.openTextDocument`, `workspace.applyEdit`, a `WorkspaceEdit` with `replace`, and
 * `Range` — over fake documents whose text this file controls. Nothing more; it is deliberately
 * not a `vscode` emulator.
 *
 * WHAT IT DOES NOT COVER, and must not be read as covering: real `WorkspaceEdit`/`applyEdit`
 * semantics, the range arithmetic against a real document, save-and-dirty behavior against a real
 * filesystem, and the phase-1-to-phase-2 concurrent-modification window (which `applyPreparedEdits`
 * guards separately with its own `getText() !== src` recheck). Those remain the job of
 * `docs/manual-test.md`'s Extension Development Host steps. The assertions below are about the
 * guard's DECISION and its zero-write abort, and should not be grown into a general apply-layer
 * suite without revisiting that boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TopologyFileEdit } from "../../src/protocol/messages";

// `vi.hoisted` so the spies exist before the hoisted `vi.mock` factory below closes over them, and
// so assertions can reach them directly instead of unwrapping an overloaded `vscode` signature.
const { openTextDocument, applyEdit, replace } = vi.hoisted(() => ({
  openTextDocument: vi.fn(),
  applyEdit: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  Range: class {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
  WorkspaceEdit: class {
    replace = replace;
  },
  workspace: { openTextDocument, applyEdit },
}));

// Imported AFTER the mock declaration purely for readability — `vi.mock` is hoisted above both.
import { applyDownRevisionEdits } from "../../src/services/repoint";

const REVISION = "aaaaaaaa0001";
const OTHER_REVISION = "cccccccc0003";
const PARENT = "bbbbbbbb0002";
const SECOND_PARENT = "dddddddd0004";
const NEW_PARENT = "eeeeeeee0005";

/** The exact user-facing rejection, written out rather than recomputed from `REVISION`, so a change
 * to the production string fails here instead of silently tracking it. */
const STALE_REASON = "aaaaaaaa: file changed since the last scan — try again";

const fileOf = (id: string) => `/tmp/${id}.py`;

/** Minimal but realistic migration source: the guard reads it through `readRevisionHeader`, i.e.
 * through parser.ts, so it has to be a file that parser actually accepts. */
function pySource(revision: string, downs: string[]): string {
  const rendered = downs.map((d) => `'${d}'`);
  const value = downs.length === 0 ? "None" : downs.length === 1 ? rendered[0] : `(${rendered.join(", ")})`;
  return `"""m

Revision ID: ${revision}
Revises: ${downs.join(", ")}
"""
revision = '${revision}'
down_revision = ${value}
`;
}

function fakeDocument(text: string) {
  return {
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => true),
    isDirty: false,
  };
}

/** Wires `openTextDocument` to serve a given text per file path. */
function serveFiles(byPath: Record<string, string>): void {
  openTextDocument.mockImplementation(async (uri: { fsPath: string }) => {
    const text = byPath[uri.fsPath];
    if (text === undefined) throw new Error(`unexpected open: ${uri.fsPath}`);
    return fakeDocument(text);
  });
}

/** A plan edit for `REVISION`: it currently revises PARENT and should end up revising NEW_PARENT. */
function planEdit(overrides: Partial<TopologyFileEdit> = {}): TopologyFileEdit {
  return {
    revisionId: REVISION,
    filePath: fileOf(REVISION),
    newDownRevisions: [NEW_PARENT],
    expectedDownRevisions: [PARENT],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  applyEdit.mockResolvedValue(true);
});

describe("applyDownRevisionEdits staleness guard", () => {
  it("a. buffer parents differ from expectedDownRevisions -> exact reason, and NOTHING is written", async () => {
    // The plan was built when the file revised PARENT; the buffer now revises something else.
    serveFiles({ [fileOf(REVISION)]: pySource(REVISION, [OTHER_REVISION]) });

    const result = await applyDownRevisionEdits([planEdit()]);

    expect(result).toEqual({ ok: false, reason: STALE_REASON });
    expect(applyEdit).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("b. the buffer declares a DIFFERENT revision id -> same rejection, nothing written", async () => {
    // The path was reused by another revision (a rename, a branch switch). Parents happen to match,
    // so only the id check can catch this.
    serveFiles({ [fileOf(REVISION)]: pySource(OTHER_REVISION, [PARENT]) });

    const result = await applyDownRevisionEdits([planEdit()]);

    // The prefix comes from the PLAN's revisionId, not the buffer's — the user recognizes the card
    // they dragged, not whatever the file turned into.
    expect(result).toEqual({ ok: false, reason: STALE_REASON });
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it("c. an unparseable header (no revision assignment) -> same rejection, nothing written", async () => {
    serveFiles({ [fileOf(REVISION)]: `"""half-written buffer"""\nfrom alembic import op\n` });

    const result = await applyDownRevisionEdits([planEdit()]);

    expect(result).toEqual({ ok: false, reason: STALE_REASON });
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it("d. a REORDERED parent tuple counts as changed (the compare is order-sensitive)", async () => {
    serveFiles({ [fileOf(REVISION)]: pySource(REVISION, [SECOND_PARENT, PARENT]) });

    const result = await applyDownRevisionEdits([planEdit({ expectedDownRevisions: [PARENT, SECOND_PARENT] })]);

    expect(result).toEqual({ ok: false, reason: STALE_REASON });
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it("e. everything matches -> the edit goes through (the guard does not over-reject)", async () => {
    serveFiles({ [fileOf(REVISION)]: pySource(REVISION, [PARENT]) });

    const result = await applyDownRevisionEdits([planEdit()]);

    expect(result).toEqual({ ok: true });
    expect(applyEdit).toHaveBeenCalledTimes(1);
    // The rewrite that was staged is the planned one, not the original text.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][2]).toContain(`down_revision = '${NEW_PARENT}'`);
  });

  it("f. one stale file in a batch aborts the WHOLE batch — the valid file is not written either", async () => {
    // This is the property the module comment claims and only a mock can witness: a topology op's
    // edits are one atomic reshaping, so a partial apply would leave a shape nobody planned.
    serveFiles({
      [fileOf(REVISION)]: pySource(REVISION, [PARENT]), // still valid
      [fileOf(OTHER_REVISION)]: pySource(OTHER_REVISION, [NEW_PARENT]), // drifted
    });

    const result = await applyDownRevisionEdits([
      planEdit(),
      planEdit({
        revisionId: OTHER_REVISION,
        filePath: fileOf(OTHER_REVISION),
        expectedDownRevisions: [PARENT],
        newDownRevisions: [],
      }),
    ]);

    expect(result).toEqual({ ok: false, reason: "cccccccc: file changed since the last scan — try again" });
    expect(applyEdit).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
