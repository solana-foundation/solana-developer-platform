import type { RampProviderId } from "@sdp/types";
import { RAMP_PROVIDERS } from "@sdp/types";
import {
  payments,
  rampProviderBvnk,
  rampProviderCoinbase,
  rampProviderLightspark,
  rampProviderMoneygram,
  rampProviderMoonpay,
  rampProviderMural,
  rampProviderStripe,
} from "@/flags";

type FlagRead = () => Promise<boolean>;

export type RampProviderFlagReads = Record<RampProviderId, FlagRead>;

const RAMP_PROVIDER_FLAGS = {
  moonpay: rampProviderMoonpay,
  lightspark: rampProviderLightspark,
  bvnk: rampProviderBvnk,
  moneygram: rampProviderMoneygram,
  coinbase: rampProviderCoinbase,
  mural: rampProviderMural,
  stripe: rampProviderStripe,
} as const satisfies RampProviderFlagReads;

/**
 * Resolves which ramp providers the given flag reads enable.
 *
 * @returns The enabled ramp providers in canonical provider order.
 */
export async function resolveEnabledRampProviders(
  providerFlags: RampProviderFlagReads
): Promise<RampProviderId[]> {
  const enabled = await Promise.all(RAMP_PROVIDERS.map((provider) => providerFlags[provider]()));
  return RAMP_PROVIDERS.filter((_, index) => enabled[index]);
}

/**
 * Whether ramps are offered at all: Payments is on and at least one provider
 * is enabled. The release channel caps every provider flag, so this follows it too.
 */
export async function resolveRampsEnabled(flags: {
  payments: FlagRead;
  providers: RampProviderFlagReads;
}): Promise<boolean> {
  const [paymentsEnabled, providers] = await Promise.all([
    flags.payments(),
    resolveEnabledRampProviders(flags.providers),
  ]);
  return paymentsEnabled && providers.length > 0;
}

/** The ramp providers enabled for the current request, in canonical provider order. */
export function getEnabledRampProviders(): Promise<RampProviderId[]> {
  return resolveEnabledRampProviders(RAMP_PROVIDER_FLAGS);
}

/** Whether the ramps surfaces (payments wizards, integrations) show for the current request. */
export function isRampsEnabled(): Promise<boolean> {
  return resolveRampsEnabled({ payments, providers: RAMP_PROVIDER_FLAGS });
}
