import type { EarnStrategy } from "@sdp/types";

/**
 * The Sandbox strategy shelf's devnet rows are the INTERSECTION with mainnet,
 * matched by name.
 *
 * A devnet vault and a mainnet vault are technically unrelated instruments —
 * different programs, different addresses, no shared identity SDP could join
 * on — so the presentation question ("does this devnet offering also exist
 * for real money?") is answered by a ROUGH name match, worked out once by
 * hand against the catalogues and hardcoded here. The sources of that
 * one-off analysis: the mainnet Kamino registry census
 * (`apps/sdp-api/.earn-catalogue/kamino.inventory.json`), the shipped curation
 * picks (`CURATED_VAULTS` in `apps/sdp-api/src/routes/earn/handlers/
 * curation.ts`), and the devnet vault names read on-chain
 * (`packages/sdp-earn/src/providers/kamino/devnet.ts`). Each entry maps a
 * devnet strategy name to the mainnet strategy name it mirrors:
 *
 * - "Steakhouse USDC" → "Steakhouse USDC" — exact name on both clusters.
 * - "Allez USDC" → "Allez USDC" — exact name; the mainnet vault is in the
 *   registry census (`A1USdzqD…`).
 * - "Gauntlet Frontier USDC" → "Gauntlet Frontier" — the devnet vault appends
 *   the deposit token to the mainnet vault's name.
 * - "RockawayX RWA USDC" → "RockawayX EUROP" — the same house's USDC vault;
 *   the devnet mirror's name postdates the mainnet one.
 *
 * Devnet vaults with no mainnet counterpart ("Kamino Vault USDC", "PyUSDC")
 * have no entry here, so they are HIDDEN from the shelf — fail-closed: a
 * renamed or newly listed devnet vault stays hidden until someone decides it
 * has a mainnet counterpart and records the pair. That is the point. The
 * sandbox shelf must not advertise offerings the production catalogue cannot
 * honour, and a hardcoded table cannot silently grow to admit them the way a
 * fuzzy matcher would.
 *
 * Veda is exempt by PROVIDER, not by name: its catalogue is devnet-only today
 * (`VEDA_DEPLOYMENTS` names no mainnet deployment, so there is no mainnet
 * shelf to intersect with) and its devnet strategies must stay visible
 * regardless. Every other provider — current and future — goes through the
 * same name table; a provider with no devnet rows is simply unaffected.
 *
 * This is a BROWSE filter for the Sandbox treasury page's combined catalogue
 * only, never a money gate: positions, the allocation summary and the
 * share-mint vocabulary all read the unfiltered shelf, exactly as API-side
 * curation keeps a customer's own program working across a hide decision.
 */

/**
 * Keys are normalized names — lowercased, whitespace-collapsed — because every
 * name here is provider free text that may legally drift in case and spacing
 * without stopping being the same vault.
 */
const MAINNET_COUNTERPART_BY_DEVNET_NAME: Readonly<Record<string, string>> = {
  "allez usdc": "Allez USDC",
  "gauntlet frontier usdc": "Gauntlet Frontier",
  "rockawayx rwa usdc": "RockawayX EUROP",
  "steakhouse usdc": "Steakhouse USDC",
};

function normalizedStrategyName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasMainnetCounterpart(strategy: EarnStrategy): boolean {
  return Object.hasOwn(MAINNET_COUNTERPART_BY_DEVNET_NAME, normalizedStrategyName(strategy.name));
}

/**
 * The devnet rows the Sandbox treasury shelf shows: every Veda strategy, plus
 * the devnet strategies this module matches to a mainnet counterpart.
 *
 * An undefined shelf passes through unchanged — the merge reads undefined as
 * "this shelf's read has not landed", which the filter must not reinterpret.
 */
export function filterSandboxDevnetStrategies(
  strategies: readonly EarnStrategy[] | undefined
): EarnStrategy[] | undefined {
  if (!strategies) return strategies;
  return strategies.filter(
    (strategy) => strategy.provider === "veda" || hasMainnetCounterpart(strategy)
  );
}
