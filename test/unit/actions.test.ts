import { describe, it, expect } from "vitest";
// Imported from actionHelpers.ts (not actions.ts) deliberately: actions.ts imports `vscode` at
// module scope for mergeHeadsAction's showInputBox/showErrorMessage calls, and `vscode` isn't
// resolvable outside a real extension host — even importing an unrelated named export from
// actions.ts here would fail the whole test file at load time. mergeHeadsAction itself is
// vscode-coupled and, per the brief, intentionally NOT unit-tested; only the pure helpers are.
import { bothAreCurrentHeads, mergeSuccessText, cliErrorText, repointSuccessText } from "../../src/ui/actionHelpers";

describe("bothAreCurrentHeads", () => {
  const heads = [{ id: "aaa" }, { id: "bbb" }, { id: "ccc" }];

  it("1a. both ids present -> true", () => {
    expect(bothAreCurrentHeads(heads, "aaa", "bbb")).toBe(true);
  });

  it("1b. order doesn't matter", () => {
    expect(bothAreCurrentHeads(heads, "ccc", "aaa")).toBe(true);
  });

  it("1c. one id missing -> false", () => {
    expect(bothAreCurrentHeads(heads, "aaa", "zzz")).toBe(false);
  });

  it("1d. neither id present -> false", () => {
    expect(bothAreCurrentHeads(heads, "yyy", "zzz")).toBe(false);
  });

  it("1e. empty heads list -> false", () => {
    expect(bothAreCurrentHeads([], "aaa", "bbb")).toBe(false);
  });

  it("1f. a === b (degenerate drop onto self) -> true only if that single id is a head", () => {
    expect(bothAreCurrentHeads(heads, "aaa", "aaa")).toBe(true);
    expect(bothAreCurrentHeads(heads, "zzz", "zzz")).toBe(false);
  });
});

describe("mergeSuccessText", () => {
  it("2a. stdout has a 'Generating ...' line -> used verbatim (trimmed)", () => {
    const stdout = "  Generating /path/to/versions/abc123_merge.py ...  done\n";
    expect(mergeSuccessText(stdout, "merge heads aaa and bbb")).toBe(
      "Merge revision created — Generating /path/to/versions/abc123_merge.py ...  done",
    );
  });

  it("2b. stdout has no 'Generating' line -> falls back to the merge message", () => {
    expect(mergeSuccessText("some unrelated output\n", "merge heads aaa and bbb")).toBe(
      "Merge revision created — merge heads aaa and bbb",
    );
  });

  it("2c. empty stdout -> falls back to the merge message", () => {
    expect(mergeSuccessText("", "my message")).toBe("Merge revision created — my message");
  });

  it("2d. picks the first matching line among several", () => {
    const stdout = "INFO some log\nGenerating first.py ... done\nGenerating second.py ... done\n";
    expect(mergeSuccessText(stdout, "fallback")).toBe("Merge revision created — Generating first.py ... done");
  });
});

describe("cliErrorText", () => {
  it("3a. non-empty stderr wins over error", () => {
    expect(cliErrorText({ error: "exit code 1", stderr: "  FAILED: some traceback  \n" })).toBe(
      "FAILED: some traceback",
    );
  });

  it("3b. blank/whitespace-only stderr falls back to error", () => {
    expect(cliErrorText({ error: "ENOENT: no such file", stderr: "   \n" })).toBe("ENOENT: no such file");
    expect(cliErrorText({ error: "ENOENT: no such file", stderr: "" })).toBe("ENOENT: no such file");
  });

  it("3c. truncates to 200 chars with an ellipsis", () => {
    const longStderr = "x".repeat(250);
    const result = cliErrorText({ error: "", stderr: longStderr });
    expect(result).toBe(`${"x".repeat(200)}…`);
    expect(result.length).toBe(201);
  });

  it("3d. exactly 200 chars is left untouched (no ellipsis)", () => {
    const exact = "y".repeat(200);
    expect(cliErrorText({ error: "", stderr: exact })).toBe(exact);
  });

  it("3e. blank stderr + a stdout FAILED line -> the FAILED line wins over error (Task 17: alembic's `revision -m` multi-head refusal prints there)", () => {
    expect(
      cliErrorText({
        error: "Command failed: /long/path/python -m alembic revision -m x",
        stderr: "",
        stdout: "FAILED: Multiple heads are present; please specify the head revision.\n",
      }),
    ).toBe("FAILED: Multiple heads are present; please specify the head revision.");
  });

  it("3f. non-FAILED stdout is never used (e.g. half-emitted SQL from a failed --sql run) -> error fallback", () => {
    expect(
      cliErrorText({ error: "exit code 1", stderr: "", stdout: "CREATE TABLE products (\n  id INTEGER\n" }),
    ).toBe("exit code 1");
  });

  it("3g. stderr still wins over a stdout FAILED line", () => {
    expect(cliErrorText({ error: "exit code 1", stderr: "real traceback", stdout: "FAILED: something else\n" })).toBe(
      "real traceback",
    );
  });
});

describe("repointSuccessText", () => {
  it("4a. target id truncated to 8 chars, matching the design's toast wording", () => {
    expect(repointSuccessText("4bfc02996c8e")).toBe("Re-pointed down_revision → 4bfc0299 · broken link fixed");
  });

  it("4b. a shorter id is used verbatim (no padding)", () => {
    expect(repointSuccessText("abc")).toBe("Re-pointed down_revision → abc · broken link fixed");
  });
});
