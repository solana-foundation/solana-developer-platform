import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { BvnkRampClient } from "./providers/bvnk";
import { LightsparkRampClient } from "./providers/lightspark";
import { MoneygramRampClient } from "./providers/moneygram";
import { MoonpayRampClient } from "./providers/moonpay";
import type {
  ProviderRampSupport,
  RampDiscoveryContext,
  RampDumpReader,
  RampProviderClient,
} from "./types";

export { BvnkRampClient } from "./providers/bvnk";
export { LightsparkRampClient } from "./providers/lightspark";
export { MoneygramRampClient } from "./providers/moneygram";
export { MoonpayRampClient } from "./providers/moonpay";
export type {
  ProviderRampSupport,
  RampDiscoveryContext,
  RampDiscoveryResponseDump,
  RampDumpReader,
  RampDumpWriter,
  RampFetchJson,
  RampProviderClient,
  RampSettlementEvent,
} from "./types";

export const RAMP_PROVIDER_CLIENTS = {
  moonpay: new MoonpayRampClient(),
  lightspark: new LightsparkRampClient(),
  bvnk: new BvnkRampClient(),
  moneygram: new MoneygramRampClient(),
} as const satisfies Record<RampProviderId, RampProviderClient>;

function assertRampProviderRegistryComplete(providers: Record<RampProviderId, RampProviderClient>) {
  for (const provider of RAMP_PROVIDERS) {
    if (!providers[provider]) {
      throw new Error(`Missing ramp provider client: ${provider}`);
    }
  }
}

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
