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
export const SERIES_COLORS = [
  "var(--sdp-series-1)",
  "var(--sdp-series-2)",
  "var(--sdp-series-3)",
  "var(--sdp-series-4)",
] as const;

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
