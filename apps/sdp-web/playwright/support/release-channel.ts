import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNEL_NAMES,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types";

/**
 * Reads the release channel the target API runs from its `/health`, so a smoke
 * probes only the modules that deployment serves. A module outside the channel
 * answers 403 by design, which must not fail the smoke.
 */
export async function fetchApiReleaseChannel(apiBaseUrl: string): Promise<SdpReleaseChannel> {
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/health`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GET /health failed (${response.status})`);
  }
  const { releaseChannel } = (await response.json()) as { releaseChannel?: unknown };
  const channel = SDP_RELEASE_CHANNEL_NAMES.find((name) => name === releaseChannel);
  if (!channel) {
    throw new Error(`GET /health returned an unknown releaseChannel: ${String(releaseChannel)}`);
  }
  return channel;
}

export function isModuleServed(releaseChannel: SdpReleaseChannel, module: SdpModule): boolean {
  return isModuleInReleaseChannel(releaseChannel, module, SDP_RAMP_PROVIDER_STAGES);
}
