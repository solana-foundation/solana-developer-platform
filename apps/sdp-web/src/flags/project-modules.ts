import type { SdpModule } from "@sdp/types/release-channels";
import {
  assetProfiles as assetProfilesFlag,
  dvp as dvpFlag,
  earn as earnFlag,
  heliusRings as heliusRingsFlag,
  issuance as issuanceFlag,
  markets as marketsFlag,
  privateChannels as privateChannelsFlag,
} from "@/flags";
import { isModuleInProjectReleaseChannel } from "./project-release-channel";

/**
 * A module flag for the request's Project: off when the release channel does not run the
 * module for the Project's environment, the check the API's project context makes, and
 * otherwise the flag's own decision. Every Project screen reads module flags from here.
 *
 * @param flag - The module's dashboard flag.
 * @param module - The module the flag shows.
 * @returns The flag capped at the Project's environment.
 */
function projectModuleFlag(
  flag: () => Promise<boolean>,
  module: SdpModule
): () => Promise<boolean> {
  return async () => (await isModuleInProjectReleaseChannel(module)) && (await flag());
}

export const issuance = projectModuleFlag(issuanceFlag, "issuance");
export const assetProfiles = projectModuleFlag(assetProfilesFlag, "issuance");
export const privateChannels = projectModuleFlag(privateChannelsFlag, "private_channels");
export const heliusRings = projectModuleFlag(heliusRingsFlag, "helius_rings");
export const markets = projectModuleFlag(marketsFlag, "markets");
export const dvp = projectModuleFlag(dvpFlag, "dvp");
export const earn = projectModuleFlag(earnFlag, "earn");
