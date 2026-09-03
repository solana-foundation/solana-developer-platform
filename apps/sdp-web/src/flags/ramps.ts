import type { RampProviderId } from "@sdp/types";
import { RAMP_PROVIDERS } from "@sdp/types";
import {
  rampProviderBvnk,
  rampProviderCoinbase,
  rampProviderLightspark,
  rampProviderMoneygram,
  rampProviderMoonpay,
  rampProviderMural,
  rampProviderStripe,
} from "@/flags";

const RAMP_PROVIDER_FLAGS = {
  moonpay: rampProviderMoonpay,
  lightspark: rampProviderLightspark,
  bvnk: rampProviderBvnk,
  moneygram: rampProviderMoneygram,
  coinbase: rampProviderCoinbase,
  mural: rampProviderMural,
  stripe: rampProviderStripe,
} as const satisfies Record<RampProviderId, typeof rampProviderMoonpay>;

/**
 * Resolves the ramp providers enabled for the current request.
 *
 * @returns The enabled ramp providers in canonical provider order.
 */
export async function getEnabledRampProviders(): Promise<RampProviderId[]> {
  const enabled = await Promise.all(
    RAMP_PROVIDERS.map((provider) => RAMP_PROVIDER_FLAGS[provider]())
  );

  return RAMP_PROVIDERS.filter((_, index) => enabled[index]);
}
