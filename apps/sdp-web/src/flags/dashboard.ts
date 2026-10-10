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
  privateChannels,
} from "@/flags";
import { getDesignModuleFlags } from "@/flags/new-design";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import type { DesignModuleFlags } from "@/lib/design-modules";
import { isRampsEnabled } from "./ramps";

export type DashboardFlags = {
  assetProfiles: boolean;
  /** Compliance integrations show whenever the deployment's release channel runs the Compliance module. */
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
    custodyEnabled,
    dvpEnabled,
    earnEnabled,
    heliusRingsEnabled,
    issuanceEnabled,
    marketsEnabled,
    newDesignEnabled,
    newDesignModules,
    paymentsEnabled,
    privateChannelsEnabled,
    rampsEnabled,
  ] = await Promise.all([
    assetProfiles(),
    custody(),
    dvp(),
    earn(),
    heliusRings(),
    issuance(),
    markets(),
    newDesign(),
    getDesignModuleFlags(),
    payments(),
    privateChannels(),
    isRampsEnabled(),
  ]);

  return {
    assetProfiles: assetProfilesEnabled,
    compliance: isModuleInDeploymentReleaseChannel("compliance"),
    custody: custodyEnabled,
    dvp: dvpEnabled,
    earn: earnEnabled,
    heliusRings: heliusRingsEnabled,
    issuance: issuanceEnabled,
    markets: marketsEnabled,
    newDesign: newDesignEnabled,
    newDesignModules,
    payments: paymentsEnabled,
    privateChannels: privateChannelsEnabled,
    ramps: rampsEnabled,
  };
}
