import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { assertRampProviderRegistryComplete, RAMP_PROVIDER_CLIENTS } from "./registry";
import type {
  ProviderRampSupport,
  RampDiscoveryContext,
  RampDumpReader,
  RampProviderClient,
} from "./types";

export { BvnkRampClient } from "./providers/bvnk";
export { LightsparkRampClient } from "./providers/lightspark";
export { MoonpayRampClient } from "./providers/moonpay";
export { RAMP_PROVIDER_CLIENTS } from "./registry";
export type {
  ProviderRampSupport,
  RampDiscoveryContext,
  RampDiscoveryResponseDump,
  RampDumpReader,
  RampDumpWriter,
  RampFetchJson,
  RampProviderClient,
} from "./types";

export class RampClient {
  constructor(
    private readonly providers: Record<RampProviderId, RampProviderClient> = RAMP_PROVIDER_CLIENTS
  ) {
    assertRampProviderRegistryComplete(providers);
  }

  /**
   * @internal Rail discovery is only intended for the support generation script.
   */
  async _discoverProviderRails(provider: RampProviderId, context: RampDiscoveryContext) {
    await this.providers[provider]._discoverRails(context);
  }

  /**
   * @internal Rail discovery is only intended for the support generation script.
   */
  async _discoverRails(providers: readonly RampProviderId[], context: RampDiscoveryContext) {
    for (const provider of providers) {
      await this._discoverProviderRails(provider, context);
    }
  }

  async readRailSupport(
    readDump: RampDumpReader
  ): Promise<Record<RampProviderId, ProviderRampSupport>> {
    const entries = await Promise.all(
      RAMP_PROVIDERS.map(async (provider) => [
        provider,
        await this.providers[provider].readRailSupport(readDump),
      ])
    );
    return Object.fromEntries(entries) as Record<RampProviderId, ProviderRampSupport>;
  }
}
