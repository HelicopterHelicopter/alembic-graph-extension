import { describe, it, expect } from "vitest";
import { buildFileDiagnostics } from "../../src/core/diagnostics";
import type { Problem } from "../../src/core/types";
import type { GhostBlame } from "../../src/protocol/messages";

const BROKEN_HINT = " — drag the ghost node onto a real revision in the Migration Graph to repair";

describe("buildFileDiagnostics", () => {
  it("1. no problems -> empty map", () => {
    expect(buildFileDiagnostics([])).toEqual(new Map());
  });

  it("2. a broken-down-revision problem -> one file, one entry, hint appended to the message", () => {
    const problems: Problem[] = [
      {
        kind: "broken-down-revision",
        summary: "`a` revises missing revision `deadbeef0000`",
        revisionIds: ["a", "deadbeef0000"],
        locations: [{ filePath: "/proj/a.py", line: 6 }],
      },
    ];

    const result = buildFileDiagnostics(problems);

    expect([...result.keys()]).toEqual(["/proj/a.py"]);
    expect(result.get("/proj/a.py")).toEqual([
      { line: 6, message: `\`a\` revises missing revision \`deadbeef0000\`${BROKEN_HINT}` },
    ]);
  });

  it("3. a duplicate-revision-id problem with two files -> two files, one entry each, no hint appended", () => {
    const problems: Problem[] = [
      {
        kind: "duplicate-revision-id",
        summary: "duplicate revision id dup1 in 2 files",
        revisionIds: ["dup1"],
        locations: [
          { filePath: "/proj/a_file.py", line: 20 },
          { filePath: "/proj/b_file.py", line: 10 },
        ],
      },
    ];

    const result = buildFileDiagnostics(problems);

    expect([...result.keys()]).toEqual(["/proj/a_file.py", "/proj/b_file.py"]);
    expect(result.get("/proj/a_file.py")).toEqual([{ line: 20, message: "duplicate revision id dup1 in 2 files" }]);
    expect(result.get("/proj/b_file.py")).toEqual([{ line: 10, message: "duplicate revision id dup1 in 2 files" }]);
  });

  it("4. a duplicate-revision-id problem with both locations in the SAME file -> one file, two entries", () => {
    const problems: Problem[] = [
      {
        kind: "duplicate-revision-id",
        summary: "duplicate revision id dup1 in 2 files",
        revisionIds: ["dup1"],
        locations: [
          { filePath: "/proj/same.py", line: 5 },
          { filePath: "/proj/same.py", line: 40 },
        ],
      },
    ];

    const result = buildFileDiagnostics(problems);

    expect([...result.keys()]).toEqual(["/proj/same.py"]);
    expect(result.get("/proj/same.py")).toEqual([
      { line: 5, message: "duplicate revision id dup1 in 2 files" },
      { line: 40, message: "duplicate revision id dup1 in 2 files" },
    ]);
  });

  it("5. multiple problems sharing a file accumulate into one entry list, in problem order", () => {
    const problems: Problem[] = [
      {
        kind: "broken-down-revision",
        summary: "`a` revises missing revision `ghostX`",
        revisionIds: ["a", "ghostX"],
        locations: [{ filePath: "/proj/shared.py", line: 6 }],
      },
      {
        kind: "duplicate-revision-id",
        summary: "duplicate revision id dupZ in 2 files",
        revisionIds: ["dupZ"],
        locations: [
          { filePath: "/proj/shared.py", line: 30 },
          { filePath: "/proj/other.py", line: 12 },
        ],
      },
    ];

    const result = buildFileDiagnostics(problems);

    expect([...result.keys()]).toEqual(["/proj/shared.py", "/proj/other.py"]);
    expect(result.get("/proj/shared.py")).toEqual([
      { line: 6, message: `\`a\` revises missing revision \`ghostX\`${BROKEN_HINT}` },
      { line: 30, message: "duplicate revision id dupZ in 2 files" },
    ]);
    expect(result.get("/proj/other.py")).toEqual([{ line: 12, message: "duplicate revision id dupZ in 2 files" }]);
  });
});

describe("buildFileDiagnostics blame enrichment (Task B1)", () => {
  const BROKEN_PROBLEM: Problem = {
    kind: "broken-down-revision",
    summary: "`a` revises missing revision `deadbeef0000`",
    revisionIds: ["a", "deadbeef0000"],
    locations: [{ filePath: "/proj/a.py", line: 6 }],
  };

  const DELETED_HERE_BLAME: GhostBlame = {
    kind: "deleted-here",
    commit: "abc123def456abc123def456abc123def456abc1",
    shortCommit: "abc123de",
    author: "Ada Lovelace",
    date: "2026-01-01T00:00:00Z",
    subject: "delete old revision",
    deletedFilePath: "versions/deadbeef0000_old.py",
  };

  const NEVER_EXISTED_BLAME: GhostBlame = {
    kind: "never-existed",
    introducedCommit: "def456abc123def456abc123def456abc123def4",
    introducedShortCommit: "def456ab",
    introducedAuthor: "Grace Hopper",
    introducedDate: "2026-02-01T00:00:00Z",
    introducedSubject: "add child",
    cherryPickedFrom: "aaa111aaa111aaa111aaa111aaa111aaa111aaa1",
    foundOn: null,
  };

  it("6. deleted-here blame -> ' — deleted in <shortCommit> by <author>' appended before the drag hint", () => {
    const result = buildFileDiagnostics([BROKEN_PROBLEM], { deadbeef0000: DELETED_HERE_BLAME });

    expect(result.get("/proj/a.py")).toEqual([
      {
        line: 6,
        message: `\`a\` revises missing revision \`deadbeef0000\` — deleted in abc123de by Ada Lovelace${BROKEN_HINT}`,
      },
    ]);
  });

  it("7. never-existed blame -> ' — never in this branch's history (introduced in <introducedShortCommit>)' appended", () => {
    const result = buildFileDiagnostics([BROKEN_PROBLEM], { deadbeef0000: NEVER_EXISTED_BLAME });

    expect(result.get("/proj/a.py")).toEqual([
      {
        line: 6,
        message: `\`a\` revises missing revision \`deadbeef0000\` — never in this branch's history (introduced in def456ab)${BROKEN_HINT}`,
      },
    ]);
  });

  it("8. no ghostBlame argument at all -> message unchanged (backward compatible, hint only)", () => {
    const result = buildFileDiagnostics([BROKEN_PROBLEM]);

    expect(result.get("/proj/a.py")).toEqual([{ line: 6, message: `\`a\` revises missing revision \`deadbeef0000\`${BROKEN_HINT}` }]);
  });

  it("9. ghostBlame provided but this missing id's entry is null (searched, not found) -> message unchanged", () => {
    const result = buildFileDiagnostics([BROKEN_PROBLEM], { deadbeef0000: null });

    expect(result.get("/proj/a.py")).toEqual([{ line: 6, message: `\`a\` revises missing revision \`deadbeef0000\`${BROKEN_HINT}` }]);
  });

  it("10. ghostBlame provided but this missing id's entry is absent (pending) -> message unchanged", () => {
    const result = buildFileDiagnostics([BROKEN_PROBLEM], {});

    expect(result.get("/proj/a.py")).toEqual([{ line: 6, message: `\`a\` revises missing revision \`deadbeef0000\`${BROKEN_HINT}` }]);
  });

  it("11. a duplicate-revision-id problem is never blame-enriched, even if ghostBlame happens to have a matching key", () => {
    const dup: Problem = {
      kind: "duplicate-revision-id",
      summary: "duplicate revision id deadbeef0000 in 2 files",
      revisionIds: ["deadbeef0000"],
      locations: [{ filePath: "/proj/dup.py", line: 3 }],
    };

    const result = buildFileDiagnostics([dup], { deadbeef0000: DELETED_HERE_BLAME });

    expect(result.get("/proj/dup.py")).toEqual([{ line: 3, message: "duplicate revision id deadbeef0000 in 2 files" }]);
  });
});
