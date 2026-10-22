import type { RampDirection } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import { badRequest, providerNotConfigured } from "#/errors";
import { MoonpayRampClient } from "./providers/moonpay/client";
import type { MoonpaySettlementEvent } from "./providers/moonpay/event-status-mapping";
import { StripeRampClient } from "./providers/stripe/client";
import {
  type RampDirectionMembers,
  type RampProvider,
  type RampSettlementEvent,
  supportsRampDirection,
} from "./types";

/** The events each provider's status pull answers, as its webhook processor reads them. */
interface RampProviderSettlementEvents {
  moonpay: MoonpaySettlementEvent;
  stripe: RampSettlementEvent;
}

/**
 * The one instance of each provider, typed as the contract: callers reach a
 * provider only through `RampProvider` members.
 */
export const RAMP_PROVIDER_CLIENTS: {
  readonly [Provider in RampProviderId]: RampProvider<RampProviderSettlementEvents[Provider]>;
} = {
  moonpay: new MoonpayRampClient(),
  stripe: new StripeRampClient(),
};

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

/**
 * `provider`'s client, narrowed to the members `direction` needs. BAD_REQUEST
 * when it does not run that direction.
 */
export function rampClientFor<Direction extends RampDirection>(
  provider: RampProviderId,
  direction: Direction
): RampProvider & RampDirectionMembers[Direction] {
  const client: RampProvider = RAMP_PROVIDER_CLIENTS[provider];
  if (!supportsRampDirection(client, direction)) {
    throw badRequest(`${provider} does not support ${direction}.`, { provider });
  }
  return client;
}
