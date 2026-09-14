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
 * one-off analysis: the live mainnet Kamino registry (`GET /kvaults/vaults`),
 * Kamino's own display config (`cdn.kamino.com/resources.json` — the names and
 * slugs kamino.com actually renders), the shipped curation picks
 * (`CURATED_VAULTS` in `apps/sdp-api/src/routes/earn/handlers/curation.ts`),
 * and the devnet vault names read on-chain
 * (`packages/sdp-earn/src/providers/kamino/devnet.ts`). Each entry maps a
 * devnet strategy name to the mainnet strategy name it mirrors:
 *
 * - "Steakhouse USDC" → "Steakhouse USDC" — exact name on both clusters
 *   (`HDsayqAs…`).
 * - "Allez USDC" → "Allez USDC" — exact name (`A1USdzqD…`).
 * - "Gauntlet Frontier USDC" → "Gauntlet Frontier" — the devnet vault appends
 *   the deposit token to the mainnet vault's name (`GFiW6eds…`; branded
 *   "Gauntlet USDC Frontier" on kamino.com).
 * - "RockawayX RWA USDC" → "RockawayX RWA USDC" — the mainnet vault's
 *   ON-CHAIN name is just "RWA USDC" (`DWSXb18x…`); Kamino brands it
 *   "RockawayX RWA USDC" in its display config, which is exactly the devnet
 *   vault's on-chain name. The counterpart is real on-chain, but the API's
 *   mainnet shelf does not list the vault today, so the mapping alone is not
 *   enough to show it (see the catalogue check below): the row stays hidden
 *   until the mainnet shelf actually offers it.
 *
 * The mapping is only half the test. A devnet strategy is admitted only when
 * the mainnet shelf itself — `baseCatalogueStrategies`, the API-visible
 * catalogue the Sandbox page renders above the devnet rows — offers the
 * mapped name from the SAME provider. The free-text devnet name alone is
 * never proof: a renamed, unrelated, or off-allowlist vault whose name
 * happens to collide with a mapped entry must not advertise a production
 * counterpart the Production shelf does not actually offer. Because the
 * catalogue lists the API-visible rows, an entry can stay in this table and
 * still be hidden — RockawayX today — until the mainnet shelf grows the row.
 *
 * The one exception is a mainnet shelf that has not landed: `undefined` reads
 * as "the mirror is loading or failed", and the devnet rows must survive a
 * mainnet mirror outage (PRO-1961). While the catalogue is unavailable its
 * verdict is unknown, so the recorded pair stands on its own and the check
 * re-applies as soon as the shelf arrives — a transient exposure while
 * loading, never a steady-state contradiction of the production shelf.
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
  "rockawayx rwa usdc": "RockawayX RWA USDC",
  "steakhouse usdc": "Steakhouse USDC",
};

function normalizedStrategyName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function mappedMainnetCounterpart(strategy: EarnStrategy): string | undefined {
  const key = normalizedStrategyName(strategy.name);
  if (!Object.hasOwn(MAINNET_COUNTERPART_BY_DEVNET_NAME, key)) return undefined;
  return MAINNET_COUNTERPART_BY_DEVNET_NAME[key];
}

function offersMainnetCounterpart(
  strategy: EarnStrategy,
  mainnetCatalogue: readonly EarnStrategy[]
): boolean {
  const counterpart = mappedMainnetCounterpart(strategy);
  if (counterpart === undefined) return false;
  return mainnetCatalogue.some(
    (candidate) =>
      candidate.provider === strategy.provider &&
      normalizedStrategyName(candidate.name) === normalizedStrategyName(counterpart)
  );
}

/**
 * The devnet rows the Sandbox treasury shelf shows: every Veda strategy, plus
 * the devnet strategies whose recorded mainnet counterpart the mainnet shelf
 * actually offers, from the same provider.
 *
 * An undefined shelf passes through unchanged — the merge reads undefined as
 * "this shelf's read has not landed", which the filter must not reinterpret.
 * An undefined MAINNET catalogue is likewise "its read has not landed"
 * (loading or failed): the recorded mapping stands alone until the catalogue
 * can confirm or refute it (PRO-1961).
 */
export function filterSandboxDevnetStrategies(
  strategies: readonly EarnStrategy[] | undefined,
  mainnetCatalogue: readonly EarnStrategy[] | undefined
): EarnStrategy[] | undefined {
  if (!strategies) return strategies;
  return strategies.filter(
    (strategy) =>
      strategy.provider === "veda" ||
      (!mainnetCatalogue
        ? mappedMainnetCounterpart(strategy) !== undefined
        : offersMainnetCounterpart(strategy, mainnetCatalogue))
  );
}
