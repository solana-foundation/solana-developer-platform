/**
 * Which series color a token wears.
 *
 * The allocation bar is ordered by value, and the previous version picked its fill
 * from that order — so a balance moving repainted tokens that had not themselves
 * changed, and the same token wore a different color on two screens. Color has to
 * follow the entity, so the mint picks the slot.
 *
 * Collisions are possible past four tokens and are deliberately tolerated: every
 * row carries its symbol, share and value, and the bar caps at four named
 * holdings plus a neutral "Other". Identity is never carried by color alone.
 */
/**
 * Utility class names, not raw `var(...)` strings.
 *
 * Tailwind treeshakes custom properties its scanner never sees, and a
 * `var(--sdp-series-1)` living only in a JS string is invisible to it — the
 * declaration got stripped from the stylesheet while this kept referencing it,
 * and every segment rendered transparent. These literals are scanned, so the
 * utilities are always generated.
 */
export const SERIES_COLORS = ["bg-series-1", "bg-series-2", "bg-series-3", "bg-series-4"] as const;

export const SERIES_COLOR_COUNT = SERIES_COLORS.length;

/** FNV-1a: small, dependency-free, and stable across renders and machines. */
function hashMint(mint: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < mint.length; index += 1) {
    hash ^= mint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function seriesColorForMint(mint: string): string {
  return SERIES_COLORS[hashMint(mint) % SERIES_COLOR_COUNT];
}
