import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import {
  isModuleInReleaseChannel,
  isRampProviderInReleaseChannel,
  resolveSdpReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import type { Adapter } from "flags";

/**
 * Caps a flag at the deployment's release channel. Inside the release channel the flag
 * keeps its own adapter's decision; outside it the flag is off whatever Vercel,
 * the env fallback, or `defaultValue` would serve.
 *
 * The release channel is read when a flag is decided, not when it is declared, so
 * building the app needs no `SDP_RELEASE_CHANNEL`; a running server without it fails
 * at start (`instrumentation.ts`).
 *
 * @param inReleaseChannel - Whether the flag's module (or ramp provider) is in the release channel.
 * @param adapter - The adapter that decides the flag inside the release channel.
 */
export function capAdapterToReleaseChannel<EntitiesType>(
  inReleaseChannel: () => boolean,
  adapter: Adapter<boolean, EntitiesType>
): Adapter<boolean, EntitiesType> {
  return {
    ...adapter,
    decide: (params) => (inReleaseChannel() ? adapter.decide(params) : false),
  };
}

/** This deployment's release channel, from `SDP_RELEASE_CHANNEL` (required; throws when unset). */
export function deploymentReleaseChannel(): SdpReleaseChannel {
  return resolveSdpReleaseChannel(process.env.SDP_RELEASE_CHANNEL);
}

/**
 * Whether this deployment runs `module` at all, the same check the API makes.
 * Unlike a module's dashboard flag it ignores per-user Vercel targeting.
 */
export function isModuleInDeploymentReleaseChannel(module: SdpModule): boolean {
  return isModuleInReleaseChannel(deploymentReleaseChannel(), module, SDP_RAMP_PROVIDER_STAGES);
}

/**
 * The ramp providers `releaseChannel` runs, in canonical order. Pure, so a client
 * component can call it with the channel from the dashboard's flag snapshot.
 */
export function rampProvidersInReleaseChannel(releaseChannel: SdpReleaseChannel): RampProviderId[] {
  return RAMP_PROVIDERS.filter((provider) =>
    isRampProviderInReleaseChannel(releaseChannel, provider, SDP_RAMP_PROVIDER_STAGES)
  );
}
