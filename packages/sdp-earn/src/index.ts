import type { EarnProviderId } from "@sdp/types/provider-access";
import { providerNotConfigured } from "./errors";
import { GroundEarnClient } from "./providers/ground/client";
import { PerenaEarnClient } from "./providers/perena/client";
import { UpshiftEarnClient } from "./providers/upshift/client";
import { VedaEarnClient } from "./providers/veda/client";
import type { EarnVaultProvider } from "./types";

export {
  badRequest,
  insufficientLiquidity,
  internalError,
  notImplemented,
  providerNotConfigured,
  providerUnavailable,
  SdpEarnError,
  type SdpEarnErrorCode,
  strategyNotAvailable,
} from "./errors";
export { GroundEarnClient } from "./providers/ground/client";
export { PerenaEarnClient } from "./providers/perena/client";
export { UpshiftEarnClient } from "./providers/upshift/client";
export { VedaEarnClient } from "./providers/veda/client";
export type {
  EarnDeclaredStrategySupport,
  EarnDepositIntent,
  EarnDepositQuote,
  EarnDepositQuoteInput,
  EarnMovementStatusInput,
  EarnMovementStatusResult,
  EarnNavInput,
  EarnRuntimeContext,
  EarnSettlementEvent,
  EarnVaultProvider,
  EarnWebhookValidationContext,
  EarnWithdrawalIntent,
  EarnWithdrawalQuote,
  EarnWithdrawalQuoteInput,
  ProviderNavSnapshot,
  ProviderStrategySnapshot,
} from "./types";

/**
 * Module-level singletons so API route tests can `vi.spyOn` a provider method
 * without touching dispatch — same shape as RAMP_PROVIDER_CLIENTS.
 */
export const EARN_PROVIDER_CLIENTS = {
  veda: new VedaEarnClient(),
  upshift: new UpshiftEarnClient(),
  perena: new PerenaEarnClient(),
  ground: new GroundEarnClient(),
} as const satisfies Record<EarnProviderId, EarnVaultProvider>;

export function isEarnProviderId(value: string): value is EarnProviderId {
  // Object.hasOwn, not `in`: provider ids come from open TEXT columns, and a
  // prototype key like "toString" must not defeat the fail-closed guard.
  return Object.hasOwn(EARN_PROVIDER_CLIENTS, value);
}

/**
 * Registry lookup that survives catalogue drift. Strategy rows persist
 * `provider` as open TEXT, so a row written by a newer deploy — or one whose
 * provider was since retired from the registry — must fail closed with a
 * clean 503, never an undefined-dispatch TypeError.
 */
export function resolveEarnProviderClient(provider: string): EarnVaultProvider {
  if (!isEarnProviderId(provider)) {
    throw providerNotConfigured(`Earn provider ${provider} is not available in this deployment`);
  }
  return EARN_PROVIDER_CLIENTS[provider];
}
