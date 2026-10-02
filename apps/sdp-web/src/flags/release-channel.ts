import {
  isModuleInReleaseChannel,
  resolveSdpReleaseChannel,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types";
import type { Adapter } from "flags";

/**
 * Caps a flag at the deployment's release channel. Inside the release channel the flag
 * keeps its own adapter untouched; outside it the flag is off whatever Vercel,
 * the env fallback, or `defaultValue` would serve.
 *
 * @param inReleaseChannel - Whether the flag's module (or ramp provider) is in the release channel.
 * @param adapter - The adapter that decides the flag inside the release channel.
 */
export function capAdapterToReleaseChannel<EntitiesType>(
  inReleaseChannel: boolean,
  adapter: Adapter<boolean, EntitiesType>
): Adapter<boolean, EntitiesType> {
  if (inReleaseChannel) {
    return adapter;
  }
  return { origin: adapter.origin, decide: () => false };
}

/** This deployment's release channel, from `SDP_RELEASE_CHANNEL` (unset is `experimental`). */
export function deploymentReleaseChannel(): SdpReleaseChannel {
  return resolveSdpReleaseChannel(process.env.SDP_RELEASE_CHANNEL);
}

/**
 * Whether this deployment runs `module` at all, the same check the API makes.
 * Unlike a module's dashboard flag it ignores per-user Vercel targeting.
 */
export function isModuleInDeploymentReleaseChannel(module: SdpModule): boolean {
  return isModuleInReleaseChannel(deploymentReleaseChannel(), module);
}
