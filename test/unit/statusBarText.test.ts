import { describe, it, expect } from "vitest";
import { currentRevisionLabel } from "../../src/ui/statusBarText";

describe("currentRevisionLabel", () => {
  it("1. no current ids -> null (status bar item hides)", () => {
    expect(currentRevisionLabel([])).toBeNull();
  });

  it("2. one current id -> 10-char prefix, singular tooltip", () => {
    expect(currentRevisionLabel(["3aebf1885b7d"])).toEqual({
      text: "current: 3aebf1885b",
      tooltip: "Current database revision",
    });
  });

  it("3. multi-head database: extra ids surface as +N in the text and enumerate in the tooltip", () => {
    expect(currentRevisionLabel(["3aebf1885b7d", "4bfc02996c8e"])).toEqual({
      text: "current: 3aebf1885b +1",
      tooltip: "2 current database revisions:\n3aebf1885b7d\n4bfc02996c8e",
    });
  });

  it("4. a short custom id is shown whole", () => {
    expect(currentRevisionLabel(["release_1"])).toEqual({
      text: "current: release_1",
      tooltip: "Current database revision",
    });
  });
});
