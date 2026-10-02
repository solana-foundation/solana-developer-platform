import {
  assetProfiles,
  custody,
  dvp,
  earn,
  heliusRings,
  issuance,
  markets,
  newDesign,
  payments,
  policies,
  privateChannels,
} from "@/flags";
import { getDesignModuleFlags } from "@/flags/new-design";
import type { DesignModuleFlags } from "@/lib/design-modules";
import { isComplianceEnabled } from "./compliance";
import { isRampsEnabled } from "./ramps";

export type DashboardFlags = {
  assetProfiles: boolean;
  /** Compliance integrations: module in the release channel and the `policies` flag on. */
  compliance: boolean;
  custody: boolean;
  dvp: boolean;
  earn: boolean;
  heliusRings: boolean;
  issuance: boolean;
  markets: boolean;
  /** NEW DESIGN; absent (older fixtures) means off. */
  newDesign?: boolean;
  /** Each design module's own flag (lib/design-modules.ts); counts only with NEW DESIGN on. */
  newDesignModules?: DesignModuleFlags;
  payments: boolean;
  policies: boolean;
  privateChannels: boolean;
  ramps: boolean;
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
    complianceEnabled,
    custodyEnabled,
    dvpEnabled,
    earnEnabled,
    heliusRingsEnabled,
    issuanceEnabled,
    marketsEnabled,
    newDesignEnabled,
    newDesignModules,
    paymentsEnabled,
    policiesEnabled,
    privateChannelsEnabled,
    rampsEnabled,
  ] = await Promise.all([
    assetProfiles(),
    isComplianceEnabled(),
    custody(),
    dvp(),
    earn(),
    heliusRings(),
    issuance(),
    markets(),
    newDesign(),
    getDesignModuleFlags(),
    payments(),
    policies(),
    privateChannels(),
    isRampsEnabled(),
  ]);

  return {
    assetProfiles: assetProfilesEnabled,
    compliance: complianceEnabled,
    custody: custodyEnabled,
    dvp: dvpEnabled,
    earn: earnEnabled,
    heliusRings: heliusRingsEnabled,
    issuance: issuanceEnabled,
    markets: marketsEnabled,
    newDesign: newDesignEnabled,
    newDesignModules,
    payments: paymentsEnabled,
    policies: policiesEnabled,
    privateChannels: privateChannelsEnabled,
    ramps: rampsEnabled,
  };
}
