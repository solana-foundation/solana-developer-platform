import {
  assetProfiles,
  dvp,
  earn,
  heliusRings,
  markets,
  organizationOnboarding,
  payments,
  privateChannels,
} from "@/flags";

export type DashboardFlags = {
  assetProfiles: boolean;
  dvp: boolean;
  earn: boolean;
  heliusRings: boolean;
  markets: boolean;
  organizationOnboarding: boolean;
  payments: boolean;
  privateChannels: boolean;
};

/**
 * Evaluates every flag the dashboard layout consumes in one request-scoped
 * pass, so the layout awaits a single snapshot instead of one promise per flag.
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
    dvpEnabled,
    earnEnabled,
    heliusRingsEnabled,
    marketsEnabled,
    organizationOnboardingEnabled,
    paymentsEnabled,
    privateChannelsEnabled,
  ] = await Promise.all([
    assetProfiles(),
    dvp(),
    earn(),
    heliusRings(),
    markets(),
    organizationOnboarding(),
    payments(),
    privateChannels(),
  ]);

  return {
    assetProfiles: assetProfilesEnabled,
    dvp: dvpEnabled,
    earn: earnEnabled,
    heliusRings: heliusRingsEnabled,
    markets: marketsEnabled,
    organizationOnboarding: organizationOnboardingEnabled,
    payments: paymentsEnabled,
    privateChannels: privateChannelsEnabled,
  };
}
