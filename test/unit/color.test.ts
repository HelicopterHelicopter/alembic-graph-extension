import { describe, it, expect } from "vitest";
import { isValidHex, hexToHsl, hslToHex, rotateHue } from "../../src/core/color";

describe("isValidHex", () => {
  it("accepts exactly 6 hex digits after #, any case", () => {
    expect(isValidHex("#c586c0")).toBe(true);
    expect(isValidHex("#000000")).toBe(true);
    expect(isValidHex("#FFFFFF")).toBe(true);
    expect(isValidHex("#4aA3fF")).toBe(true);
  });

  it("rejects anything else: no #, wrong length, named colors, css functions, empty", () => {
    expect(isValidHex("c586c0")).toBe(false);
    expect(isValidHex("#c586c")).toBe(false); // 5 digits
    expect(isValidHex("#c586c000")).toBe(false); // 8 digits
    expect(isValidHex("#c86")).toBe(false); // short form not accepted
    expect(isValidHex("red")).toBe(false);
    expect(isValidHex("rgb(197,134,192)")).toBe(false);
    expect(isValidHex("")).toBe(false);
    expect(isValidHex("#gggggg")).toBe(false); // non-hex letters
  });
});

describe("hexToHsl", () => {
  it("pins the default laneColorB (#c586c0)", () => {
    const { h, s, l } = hexToHsl("#c586c0");
    expect(h).toBeCloseTo(304.762, 2);
    expect(s).toBeCloseTo(35.196, 2);
    expect(l).toBeCloseTo(64.902, 2);
  });

  it("pure red/green/blue land on the expected hue", () => {
    expect(hexToHsl("#ff0000")).toEqual({ h: 0, s: 100, l: 50 });
    expect(hexToHsl("#00ff00").h).toBeCloseTo(120, 5);
    expect(hexToHsl("#0000ff").h).toBeCloseTo(240, 5);
  });

  it("gray (r=g=b) has zero saturation and no NaN hue", () => {
    const { h, s, l } = hexToHsl("#808080");
    expect(s).toBe(0);
    expect(h).toBe(0); // achromatic: hue is conventionally 0, never NaN
    expect(l).toBeCloseTo(50.2, 1);
  });
});

describe("hslToHex", () => {
  it("round-trips primary hues at full saturation/mid lightness", () => {
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
    expect(hslToHex(120, 100, 50)).toBe("#00ff00");
    expect(hslToHex(240, 100, 50)).toBe("#0000ff");
  });

  it("wraps hue outside [0,360) and clamps out-of-range s/l instead of NaN-ing", () => {
    expect(hslToHex(-120, 100, 50)).toBe(hslToHex(240, 100, 50)); // negative wraps
    expect(hslToHex(480, 100, 50)).toBe(hslToHex(120, 100, 50)); // >360 wraps
    expect(hslToHex(0, 150, 50)).toBe(hslToHex(0, 100, 50)); // s clamped to 100
    expect(hslToHex(0, 100, -20)).toBe(hslToHex(0, 100, 0)); // l clamped to 0
  });
});

describe("rotateHue", () => {
  // Pinned against the real algorithm (see task-21 report for the derivation script) — a
  // regression here means the lane color scale visibly shifted.
  it("known hex -> expected rotated hex, 3 pinned values off the default laneColorB", () => {
    expect(rotateHue("#c586c0", 40)).toBe("#c58696");
    expect(rotateHue("#c586c0", 80)).toBe("#c5a086");
    expect(rotateHue("#c586c0", 120)).toBe("#c0c586");
  });

  it("clamps saturation/lightness so an achromatic (black/white) input never NaNs and always produces a valid 6-hex color", () => {
    for (const hex of ["#000000", "#ffffff", "#808080"]) {
      const result = rotateHue(hex, 40);
      expect(result).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("degrees=0 is a near-identity modulo the sanity clamp (hue unchanged for an already-in-range color)", () => {
    // laneColorB itself sits well inside [35,70] lightness / >=35 saturation, so a 0° rotation is
    // an exact round trip through HSL and back.
    expect(rotateHue("#c586c0", 0)).toBe("#c586c0");
  });
});
