import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { BvnkRampClient } from "./providers/bvnk";
import { LightsparkRampClient } from "./providers/lightspark";
import { MoonpayRampClient } from "./providers/moonpay";
import type { RampProviderClient } from "./types";

export const RAMP_PROVIDER_CLIENTS = {
  moonpay: new MoonpayRampClient(),
  lightspark: new LightsparkRampClient(),
  bvnk: new BvnkRampClient(),
} as const satisfies Record<RampProviderId, RampProviderClient>;

export function assertRampProviderRegistryComplete(
  providers: Record<RampProviderId, RampProviderClient>
) {
  for (const provider of RAMP_PROVIDERS) {
    if (!providers[provider]) {
      throw new Error(`Missing ramp provider client: ${provider}`);
    }
  }
}
