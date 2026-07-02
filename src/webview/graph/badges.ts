/**
 * CURRENT/HEAD/MERGE/BROKEN badge element builder, shared by card headers (render.ts) and the
 * revision detail panel (detail.ts) so the badge palette/order lives in exactly one place. Split
 * out of render.ts (rather than exported from it) so detail.ts can import it without a
 * render.ts <-> detail.ts circular dependency.
 */

/** Flags shared by card badges and the detail panel's badge row — kept structural (not tied to
 * `LayoutNode`) so `RevisionDetail` satisfies it too without an adapter. */
export interface BadgeFlags {
  isCurrent: boolean;
  isHead: boolean;
  isMerge: boolean;
  isBroken: boolean;
}

/** Builds the raw badge elements (no wrapper) for `flags`, in fixed CURRENT/HEAD/MERGE/BROKEN
 * order — callers append them into whatever wrapper their layout needs. */
export function buildBadgeItems(flags: BadgeFlags): HTMLElement[] {
  const items: { text: string; cls: string }[] = [];
  if (flags.isCurrent) items.push({ text: "CURRENT", cls: "alx-badge--current" });
  if (flags.isHead) items.push({ text: "HEAD", cls: "alx-badge--head" });
  if (flags.isMerge) items.push({ text: "MERGE", cls: "alx-badge--merge" });
  if (flags.isBroken) items.push({ text: "BROKEN", cls: "alx-badge--broken" });

  return items.map((item) => {
    const badge = document.createElement("div");
    badge.className = `alx-badge ${item.cls}`;
    badge.textContent = item.text;
    return badge;
  });
}
