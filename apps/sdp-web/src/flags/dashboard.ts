import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import {
  assetProfiles,
  dvp,
  earn,
  heliusRings,
  issuance,
  markets,
  newDesign,
  paymentsDemoMode,
  privateChannels,
} from "@/flags";
import { getDesignModuleFlags } from "@/flags/new-design";
import {
  deploymentReleaseChannel,
  isModuleInDeploymentReleaseChannel,
} from "@/flags/release-channel";
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
  /** Payments' Demo switch; absent (older fixtures) follows NEW DESIGN. */
  paymentsDemoMode?: boolean;
  privateChannels: boolean;
  ramps: boolean;
  /** This deployment's release channel; the API playground offers only its modules. */
  releaseChannel: SdpReleaseChannel;
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
    dvpEnabled,
    earnEnabled,
    heliusRingsEnabled,
    issuanceEnabled,
    marketsEnabled,
    newDesignEnabled,
    newDesignModules,
    paymentsDemoModeEnabled,
    privateChannelsEnabled,
    rampsEnabled,
  ] = await Promise.all([
    assetProfiles(),
    dvp(),
    earn(),
    heliusRings(),
    issuance(),
    markets(),
    newDesign(),
    getDesignModuleFlags(),
    paymentsDemoMode(),
    privateChannels(),
    isRampsEnabled(),
  ]);

  return {
    assetProfiles: assetProfilesEnabled,
    compliance: isModuleInDeploymentReleaseChannel("compliance"),
    // Custody and Payments are `stable` and have no flag of their own: the release channel alone decides (HOO-1956).
    custody: isModuleInDeploymentReleaseChannel("custody"),
    dvp: dvpEnabled,
    earn: earnEnabled,
    heliusRings: heliusRingsEnabled,
    issuance: issuanceEnabled,
    markets: marketsEnabled,
    newDesign: newDesignEnabled,
    newDesignModules,
    payments: isModuleInDeploymentReleaseChannel("payments"),
    paymentsDemoMode: paymentsDemoModeEnabled,
    privateChannels: privateChannelsEnabled,
    ramps: rampsEnabled,
    releaseChannel: deploymentReleaseChannel(),
  };
}
