/*
 * The crypto a demo ramp can deliver or take: only what the demo wallets hold. A pair for any
 * other asset (PYUSD, USDT, USDG) is left out of the demo's pickers and refused by its quotes,
 * so a demo never shows one asset chosen and another credited. Kept apart from the fixtures so
 * the ramp screens can read it; demo-fixtures' DEMO_TOKENS must hold every one of these.
 */

/** The asset a rail names, as the rail spells it ("usdc.solana" → "usdc"). */
export function railAsset(assetRail: string): string {
  return assetRail.split(".", 1)[0]?.toLowerCase() ?? "";
}

/** The assets the demo wallets hold, as rails spell them. */
export const DEMO_RAMP_ASSETS: ReadonlySet<string> = new Set(["usdc", "sol", "eurc"]);

/** Whether a demo ramp can run on this asset rail. */
export function isDemoRampRail(assetRail: string): boolean {
  return DEMO_RAMP_ASSETS.has(railAsset(assetRail));
}

/** The pairs a ramp screen offers: in demo mode, only those for an asset the demo holds. */
export function demoRampPairs<T extends { assetRail: string }>(
  pairs: readonly T[],
  demo: boolean
): T[] {
  return pairs.filter((pair) => !demo || isDemoRampRail(pair.assetRail));
}
