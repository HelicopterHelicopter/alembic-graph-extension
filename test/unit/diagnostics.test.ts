import { describe, it, expect } from "vitest";
import { buildFileDiagnostics } from "../../src/core/diagnostics";
import type { Problem } from "../../src/core/types";

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
