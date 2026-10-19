import type { RampProviderId } from "@sdp/types/provider-access";
import { providerNotConfigured } from "#/errors";
import { MoonpayRampClient } from "./providers/moonpay/client";
import { StripeRampClient } from "./providers/stripe/client";
import type { RampProvider } from "./types";

export const RAMP_PROVIDER_CLIENTS = {
  moonpay: new MoonpayRampClient(),
  stripe: new StripeRampClient(),
} as const satisfies Record<RampProviderId, RampProvider>;

export function isRampProviderId(value: string): value is RampProviderId {
  // Object.hasOwn, not `in`: provider ids come from open TEXT columns, and a
  // prototype key like "toString" must not defeat the fail-closed guard.
  return Object.hasOwn(RAMP_PROVIDER_CLIENTS, value);
}

/**
 * Registry lookup for a provider id read from a stored row. A retired id (see
 * `RETIRED_RAMP_PROVIDERS`) or one this deployment does not know answers 503
 * PROVIDER_NOT_CONFIGURED, never an undefined-dispatch TypeError.
 */
export function resolveRampProviderClient(provider: string): RampProvider {
  if (!isRampProviderId(provider)) {
    throw providerNotConfigured(`Ramp provider ${provider} is not available in this deployment`, {
      provider,
    });
  }
  return RAMP_PROVIDER_CLIENTS[provider];
}
