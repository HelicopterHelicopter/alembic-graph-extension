/**
 * Pure hex/HSL color helpers backing `laneColorsFor` (migrationService.ts): lanes 0/1 use the two
 * configured settings colors verbatim, lanes >= 2 hue-rotate lane 1's color. No `vscode`/DOM APIs —
 * same purity rule as every other core/ file, fully vitest-testable in isolation.
 */

/** `#rrggbb`, case-insensitive, exactly 6 hex digits — anything else (short/`#rgb` forms, named
 * CSS colors, `rgb(...)`, missing `#`, garbage) is rejected. This is also the hardening the Task 20
 * review flagged: a workspace-settings string reaching a hue-rotation/CSS sink unvalidated is an
 * injection vector, so every call site that reads `laneColorA`/`laneColorB` (config read in
 * extension.ts, and `laneColorsFor` itself as a second, independent line of defense) validates
 * against this before using the value for anything. */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidHex(color: string): boolean {
  return HEX_RE.test(color);
}

/** The two `alembicGraph.laneColorA`/`laneColorB` setting defaults (package.json's declared
 * defaults) — the ONE place both values live as literals. `extension.ts`'s `sanitizeLaneColor`
 * (config-read validation) and `migrationService.ts`'s `laneColorsFor` (its own independent
 * fallback) both import these rather than each hardcoding their own copy, so the two layers of
 * validation can never silently disagree on what "the default" actually is. */
export const DEFAULT_LANE_COLOR_A = "#4aa3ff";
export const DEFAULT_LANE_COLOR_B = "#c586c0";

/** `#rrggbb` -> HSL (h in [0,360), s/l in [0,100]). Caller must validate with `isValidHex` first —
 * this does no validation of its own and will produce NaNs for non-hex input. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }

  return { h, s: s * 100, l: l * 100 };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** HSL -> `#rrggbb`. `h` may be any real number (wrapped into [0,360)); `s`/`l` are clamped to
 * [0,100] regardless of what's passed in. */
export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;

  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const toHex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Minimum saturation/lightness bounds a rotated lane color is clamped into — an unclamped
 * rotation can land on a washed-out (near-zero saturation) or near-black/near-white (extreme
 * lightness) color for some inputs, which would be unreadable against the graph's dark canvas. */
const MIN_SATURATION = 35;
const MIN_LIGHTNESS = 35;
const MAX_LIGHTNESS = 70;

/** Rotates `hex`'s hue by `degrees` (lanes >= 2 in `laneColorsFor`), clamping saturation and
 * lightness into a sane, always-visible range. Caller must validate `hex` with `isValidHex` first. */
export function rotateHue(hex: string, degrees: number): string {
  const { h, s, l } = hexToHsl(hex);
  const clampedS = clamp(Math.max(s, MIN_SATURATION), MIN_SATURATION, 100);
  const clampedL = clamp(l, MIN_LIGHTNESS, MAX_LIGHTNESS);
  return hslToHex(h + degrees, clampedS, clampedL);
}
