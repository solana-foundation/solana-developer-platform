import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { paymentsDemoMode } from "@/flags";
import {
  assetProfiles,
  dvp,
  earn,
  heliusRings,
  issuance,
  markets,
  privateChannels,
} from "@/flags/project-modules";
import { deploymentReleaseChannel } from "@/flags/release-channel";
import { isModuleInProjectReleaseChannel } from "./project-release-channel";
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
  payments: boolean;
  /** Payments' Demo switch; absent (older fixtures) means on. */
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
    paymentsDemoModeEnabled,
    privateChannelsEnabled,
    rampsEnabled,
    complianceInChannel,
    custodyInChannel,
    paymentsInChannel,
  ] = await Promise.all([
    assetProfiles(),
    dvp(),
    earn(),
    heliusRings(),
    issuance(),
    markets(),
    paymentsDemoMode(),
    privateChannels(),
    isRampsEnabled(),
    isModuleInProjectReleaseChannel("compliance"),
    isModuleInProjectReleaseChannel("custody"),
    isModuleInProjectReleaseChannel("payments"),
  ]);

  return {
    assetProfiles: assetProfilesEnabled,
    compliance: complianceInChannel,
    // Custody and Payments are `stable` and have no flag of their own: the release channel alone decides (HOO-1956).
    custody: custodyInChannel,
    dvp: dvpEnabled,
    earn: earnEnabled,
    heliusRings: heliusRingsEnabled,
    issuance: issuanceEnabled,
    markets: marketsEnabled,
    payments: paymentsInChannel,
    paymentsDemoMode: paymentsDemoModeEnabled,
    privateChannels: privateChannelsEnabled,
    ramps: rampsEnabled,
    releaseChannel: deploymentReleaseChannel(),
  };
}
