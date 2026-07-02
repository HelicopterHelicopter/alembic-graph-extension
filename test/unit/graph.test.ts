import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseRevisionSource } from "../../src/core/parser";
import { buildGraph, computeAppliedSet } from "../../src/core/graph";
import type { ParsedRevision } from "../../src/core/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKEN_VERSIONS_DIR = path.join(here, "../../fixtures/broken-project/alembic/versions");

/** Builds a ParsedRevision literal with sane defaults so each test only specifies what matters. */
function mkRevision(opts: {
  revision: string;
  downRevisions?: string[];
  branchLabels?: string[];
  message?: string;
  createDate?: string | null;
  filePath?: string;
  revisionLine?: number;
  downRevisionLine?: number | null;
}): ParsedRevision {
  return {
    revision: opts.revision,
    downRevisions: opts.downRevisions ?? [],
    branchLabels: opts.branchLabels ?? [],
    message: opts.message ?? "",
    createDate: opts.createDate ?? null,
    filePath: opts.filePath ?? `${opts.revision}.py`,
    revisionLine: opts.revisionLine ?? 0,
    downRevisionLine: opts.downRevisionLine === undefined ? 1 : opts.downRevisionLine,
  };
}

describe("buildGraph", () => {
  it("1. linear chain: single head, single root, no ghosts/problems, correct children index", () => {
    const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: "2026-01-02 00:00:00.000000" });
    const c = mkRevision({ revision: "c", downRevisions: ["b"], createDate: "2026-01-03 00:00:00.000000" });
    const graph = buildGraph([a, b, c]);

    expect(Object.keys(graph.nodes).sort()).toEqual(["a", "b", "c"]);
    expect(graph.heads).toEqual(["c"]);
    expect(graph.roots).toEqual(["a"]);
    expect(graph.ghosts).toEqual([]);
    expect(graph.problems).toEqual([]);
    expect(graph.children).toEqual({ a: ["b"], b: ["c"], c: [] });
    expect(graph.nodes.a.isRoot).toBe(true);
    expect(graph.nodes.a.isHead).toBe(false);
    expect(graph.nodes.b.isRoot).toBe(false);
    expect(graph.nodes.b.isHead).toBe(false);
    expect(graph.nodes.b.isMerge).toBe(false);
    expect(graph.nodes.b.isBroken).toBe(false);
    expect(graph.nodes.c.isHead).toBe(true);
  });

  it("2. two heads after divergence, newest-first with correctly ordered children", () => {
    const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: "2026-01-02 00:00:00.000000" });
    const c = mkRevision({ revision: "c", downRevisions: ["a"], createDate: "2026-01-03 00:00:00.000000" });
    const graph = buildGraph([a, b, c]);

    expect(graph.heads).toEqual(["c", "b"]); // c is newer than b
    expect(graph.roots).toEqual(["a"]);
    expect(graph.children.a).toEqual(["b", "c"]); // children sorted oldest-first
  });

  it("3. merge node: isMerge true, heads collapse to one after the merge", () => {
    const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: "2026-01-02 00:00:00.000000" });
    const c = mkRevision({ revision: "c", downRevisions: ["a"], createDate: "2026-01-03 00:00:00.000000" });
    const d = mkRevision({
      revision: "d",
      downRevisions: ["b", "c"],
      createDate: "2026-01-04 00:00:00.000000",
    });
    const graph = buildGraph([a, b, c, d]);

    expect(graph.nodes.d.isMerge).toBe(true);
    expect(graph.nodes.b.isMerge).toBe(false);
    expect(graph.heads).toEqual(["d"]);
    expect(graph.children.a).toEqual(["b", "c"]);
    expect(graph.children.b).toEqual(["d"]);
    expect(graph.children.c).toEqual(["d"]);
  });

  it("4a. broken link: ghost created, child isBroken, problem at downRevisionLine; childless broken node is a head", () => {
    const a = mkRevision({
      revision: "a",
      downRevisions: ["deadbeef0000"],
      createDate: "2026-01-01 00:00:00.000000",
      filePath: "/proj/a.py",
      revisionLine: 5,
      downRevisionLine: 6,
    });
    const graph = buildGraph([a]);

    expect(graph.nodes.a.isBroken).toBe(true);
    expect(graph.nodes.a.isRoot).toBe(false); // downRevisions is non-empty (points at a ghost)
    expect(graph.ghosts).toEqual([{ id: "deadbeef0000", childIds: ["a"] }]);
    expect(graph.heads).toEqual(["a"]); // childless AND broken
    expect(graph.children["deadbeef0000"]).toEqual(["a"]);
    expect(graph.problems).toEqual([
      {
        kind: "broken-down-revision",
        summary: "`a` revises missing revision `deadbeef0000`",
        revisionIds: ["a", "deadbeef0000"],
        locations: [{ filePath: "/proj/a.py", line: 6 }],
      },
    ]);
  });

  it("4b. falls back to revisionLine when downRevisionLine is null", () => {
    const a = mkRevision({
      revision: "a",
      downRevisions: ["deadbeef0000"],
      filePath: "/proj/a.py",
      revisionLine: 5,
      downRevisionLine: null,
    });
    const graph = buildGraph([a]);

    expect(graph.problems[0].locations).toEqual([{ filePath: "/proj/a.py", line: 5 }]);
  });

  it("5. two children pointing at the same missing id produce one ghost and two problems", () => {
    const a = mkRevision({ revision: "a", downRevisions: ["ghostX"], createDate: "2026-01-02 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["ghostX"], createDate: "2026-01-01 00:00:00.000000" });
    const graph = buildGraph([a, b]);

    expect(graph.ghosts).toEqual([{ id: "ghostX", childIds: ["b", "a"] }]); // b has the earlier createDate
    expect(graph.problems).toHaveLength(2);
    expect(graph.problems.map((p) => p.revisionIds)).toEqual([
      ["a", "ghostX"], // ordered by child id ascending
      ["b", "ghostX"],
    ]);
    expect(graph.problems.every((p) => p.kind === "broken-down-revision")).toBe(true);
  });

  it("6. duplicate revision id: first-by-filePath wins, problem lists both locations", () => {
    const dupA = mkRevision({ revision: "dup1", filePath: "/proj/b_file.py", revisionLine: 10, message: "second" });
    const dupB = mkRevision({ revision: "dup1", filePath: "/proj/a_file.py", revisionLine: 20, message: "first" });
    const graph = buildGraph([dupA, dupB]);

    expect(Object.keys(graph.nodes)).toEqual(["dup1"]);
    expect(graph.nodes.dup1.filePath).toBe("/proj/a_file.py"); // "a_file.py" < "b_file.py"
    expect(graph.nodes.dup1.message).toBe("first");
    expect(graph.problems).toEqual([
      {
        kind: "duplicate-revision-id",
        summary: "duplicate revision id dup1 in 2 files",
        revisionIds: ["dup1"],
        locations: [
          { filePath: "/proj/a_file.py", line: 20 },
          { filePath: "/proj/b_file.py", line: 10 },
        ],
      },
    ]);
  });

  it("8. buildGraph on an a<->b cycle terminates with no heads/roots/ghosts/problems", () => {
    const a = mkRevision({ revision: "a", downRevisions: ["b"], createDate: "2026-01-01 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: "2026-01-02 00:00:00.000000" });
    const graph = buildGraph([a, b]);

    expect(Object.keys(graph.nodes).sort()).toEqual(["a", "b"]);
    expect(graph.heads).toEqual([]);
    expect(graph.roots).toEqual([]);
    expect(graph.ghosts).toEqual([]);
    expect(graph.problems).toEqual([]);
    expect(graph.children).toEqual({ a: ["b"], b: ["a"] });
  });

  it("9. determinism: same revisions in any order produce a deeply identical graph", () => {
    const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: "2026-01-02 00:00:00.000000" });
    const c = mkRevision({ revision: "c", downRevisions: ["a"], createDate: "2026-01-03 00:00:00.000000" });
    const d = mkRevision({
      revision: "d",
      downRevisions: ["b", "c"],
      createDate: "2026-01-04 00:00:00.000000",
    });
    const e = mkRevision({ revision: "e", downRevisions: ["ghostZ"], createDate: "2026-01-05 00:00:00.000000" });

    const g1 = buildGraph([a, b, c, d, e]);
    const g2 = buildGraph([e, d, c, b, a]);
    const g3 = buildGraph([c, e, a, d, b]);

    expect(g2).toEqual(g1);
    expect(g3).toEqual(g1);
  });

  describe("edge cases (self-review)", () => {
    it("orders problems broken-first (by child id) then duplicates (by id)", () => {
      const dupA = mkRevision({ revision: "z-dup", filePath: "/proj/b.py" });
      const dupB = mkRevision({ revision: "z-dup", filePath: "/proj/a.py" });
      const broken = mkRevision({ revision: "a-broken", downRevisions: ["ghostQ"] });
      const graph = buildGraph([dupA, dupB, broken]);

      expect(graph.problems.map((p) => p.kind)).toEqual(["broken-down-revision", "duplicate-revision-id"]);
    });

    it("heads tie-break: equal createDate sorts by id ascending", () => {
      const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
      const x = mkRevision({ revision: "x", downRevisions: ["a"], createDate: "2026-02-01 00:00:00.000000" });
      const y = mkRevision({ revision: "y", downRevisions: ["a"], createDate: "2026-02-01 00:00:00.000000" });
      const graph = buildGraph([a, x, y]);

      expect(graph.heads).toEqual(["x", "y"]);
    });

    it("null createDate sorts oldest: first in roots, last in heads", () => {
      const nullDated = mkRevision({ revision: "r-null", createDate: null });
      const dated = mkRevision({ revision: "r-dated", createDate: "2026-01-01 00:00:00.000000" });
      const graph = buildGraph([nullDated, dated]);

      expect(graph.roots).toEqual(["r-null", "r-dated"]);
      expect(graph.heads).toEqual(["r-dated", "r-null"]);
    });
  });
});

describe("computeAppliedSet", () => {
  it("7a. includes linear ancestors", () => {
    const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: "2026-01-02 00:00:00.000000" });
    const c = mkRevision({ revision: "c", downRevisions: ["b"], createDate: "2026-01-03 00:00:00.000000" });
    const graph = buildGraph([a, b, c]);

    expect(computeAppliedSet(graph, ["c"])).toEqual(new Set(["a", "b", "c"]));
  });

  it("7b. through a merge, both parents become applied", () => {
    const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: "2026-01-02 00:00:00.000000" });
    const c = mkRevision({ revision: "c", downRevisions: ["a"], createDate: "2026-01-03 00:00:00.000000" });
    const d = mkRevision({
      revision: "d",
      downRevisions: ["b", "c"],
      createDate: "2026-01-04 00:00:00.000000",
    });
    const graph = buildGraph([a, b, c, d]);

    expect(computeAppliedSet(graph, ["d"])).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("7c. ignores an unknown id in currentIds", () => {
    const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
    const graph = buildGraph([a]);

    expect(computeAppliedSet(graph, ["a", "does-not-exist"])).toEqual(new Set(["a"]));
  });

  it("7d. an a<->b cycle terminates and resolves both ids as applied", () => {
    const a = mkRevision({ revision: "a", downRevisions: ["b"], createDate: "2026-01-01 00:00:00.000000" });
    const b = mkRevision({ revision: "b", downRevisions: ["a"], createDate: "2026-01-02 00:00:00.000000" });
    const graph = buildGraph([a, b]);

    expect(computeAppliedSet(graph, ["a"])).toEqual(new Set(["a", "b"]));
  });

  it("returns an empty set when currentIds is empty", () => {
    const a = mkRevision({ revision: "a", createDate: "2026-01-01 00:00:00.000000" });
    const graph = buildGraph([a]);

    expect(computeAppliedSet(graph, [])).toEqual(new Set());
  });
});

describe("fixture integration: fixtures/broken-project/alembic/versions", () => {
  const files = readdirSync(BROKEN_VERSIONS_DIR).filter((f) => f.endsWith(".py"));
  const revisions = files
    .map((file) => parseRevisionSource(readFileSync(path.join(BROKEN_VERSIONS_DIR, file), "utf8"), file))
    .filter((r): r is ParsedRevision => r !== null);

  it("10. builds the expected graph shape from the broken fixture project", () => {
    expect(revisions).toHaveLength(12);

    const graph = buildGraph(revisions);

    expect(Object.keys(graph.nodes)).toHaveLength(12);
    expect(graph.heads).toEqual(["5c0d13aa7d9f", "4bfc02996c8e", "3aebf1885b7d"]);
    expect(graph.ghosts).toEqual([{ id: "deadbeef0000", childIds: ["5c0d13aa7d9f"] }]);
    expect(graph.problems).toHaveLength(1);
    expect(graph.problems[0].kind).toBe("broken-down-revision");
    expect(graph.problems[0].revisionIds).toEqual(["5c0d13aa7d9f", "deadbeef0000"]);
    expect(graph.nodes["29dae0774a6c"].isMerge).toBe(true);
    expect(graph.roots).toEqual(["8f2a1c9d4e07"]);
    expect(graph.nodes["f6a9b7241d3c"].branchLabels).toEqual(["billing"]);
  });
});
