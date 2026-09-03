import {
  assetProfiles,
  custody,
  earn,
  heliusRings,
  issuance,
  markets,
  payments,
  policies,
  privateChannels,
} from "@/flags";

export type DashboardFlags = {
  assetProfiles: boolean;
  custody: boolean;
  earn: boolean;
  heliusRings: boolean;
  issuance: boolean;
  markets: boolean;
  payments: boolean;
  policies: boolean;
  privateChannels: boolean;
};

/**
 * Evaluates every flag the dashboard layout consumes in one request-scoped
 * pass, so the layout awaits a single snapshot instead of separate flag reads.
 *
 * Lives beside the definitions instead of in index.ts because the flags
 * discovery endpoint serves that module wholesale and accepts only flag
 * definitions as exports.
 *
 * @returns The resolved dashboard flag values for the current request.
 */
export async function getDashboardFlags(): Promise<DashboardFlags> {
  const [
    assetProfilesEnabled,
    custodyEnabled,
    earnEnabled,
    heliusRingsEnabled,
    issuanceEnabled,
    marketsEnabled,
    paymentsEnabled,
    policiesEnabled,
    privateChannelsEnabled,
  ] = await Promise.all([
    assetProfiles(),
    custody(),
    earn(),
    heliusRings(),
    issuance(),
    markets(),
    payments(),
    policies(),
    privateChannels(),
  ]);

  return {
    assetProfiles: assetProfilesEnabled,
    custody: custodyEnabled,
    earn: earnEnabled,
    heliusRings: heliusRingsEnabled,
    issuance: issuanceEnabled,
    markets: marketsEnabled,
    payments: paymentsEnabled,
    policies: policiesEnabled,
    privateChannels: privateChannelsEnabled,
  };
}
