import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { BvnkRampClient } from "./providers/bvnk/client";
import { CoinbaseRampClient } from "./providers/coinbase/client";
import { LightsparkRampClient } from "./providers/lightspark/client";
import { MoneygramRampClient } from "./providers/moneygram/client";
import { MoonpayRampClient } from "./providers/moonpay/client";
import type {
  ProviderRampSupport,
  RampDiscoveryContext,
  RampDumpReader,
  RampProvider,
} from "./types";

export { BvnkRampClient } from "./providers/bvnk/client";
export { CoinbaseRampClient } from "./providers/coinbase/client";
export { LightsparkRampClient } from "./providers/lightspark/client";
export { MoneygramRampClient } from "./providers/moneygram/client";
export { MoonpayRampClient } from "./providers/moonpay/client";
export type {
  ProviderRampSupport,
  RampDiscoveryContext,
  RampDiscoveryResponseDump,
  RampDumpReader,
  RampDumpWriter,
  RampFetchJson,
  RampProvider,
  RampSettlementEvent,
} from "./types";

export const RAMP_PROVIDER_CLIENTS = {
  moonpay: new MoonpayRampClient(),
  lightspark: new LightsparkRampClient(),
  bvnk: new BvnkRampClient(),
  moneygram: new MoneygramRampClient(),
  coinbase: new CoinbaseRampClient(),
} as const satisfies Record<RampProviderId, RampProvider>;

export class RampClient {
  /**
   * @internal Rail discovery is only intended for the support generation script.
   */
  async _discoverProviderRails(provider: RampProviderId, context: RampDiscoveryContext) {
    await RAMP_PROVIDER_CLIENTS[provider]._discoverRails(context);
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
        await RAMP_PROVIDER_CLIENTS[provider].readRailSupport(readDump),
      ])
    );
    return Object.fromEntries(entries) as Record<RampProviderId, ProviderRampSupport>;
  }
}
