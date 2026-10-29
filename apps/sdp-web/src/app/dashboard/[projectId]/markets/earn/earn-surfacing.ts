import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { EarnStrategy } from "@sdp/types/earn";
import {
  type EarnProviderId,
  earnDepositStyle,
  isEarnProviderSurfaced,
  isVaultDirectDepositEnabled,
  type ProviderAvailabilityEntry,
  SURFACED_EARN_PROVIDERS,
} from "@sdp/types/provider-access";

export type EarnProviderAccess = Readonly<
  Partial<Record<EarnProviderId, ProviderAvailabilityEntry>>
>;

export type EarnVaultDepositAvailability =
  | "available"
  | "cluster_unavailable"
  | "strategy_unavailable"
  | "environment_unavailable"
  | "access_unavailable"
  | "provider_unavailable";

/**
 * Which providers this module drives, and whether a deposit is offered.
 *
 * **This file carries no `"use client"` directive, and that is the whole reason
 * it exists.** A Server Component importing a value from a client module
 * receives a client-reference PROXY, not the value. The proxy is an object, so
 * a server-side guard on such a constant is always truthy and silently never
 * fires. Typecheck passes (the types are right) and unit tests pass (they mock
 * the module), so only a browser catches it.
 *
 * Keep server-readable gates here. Anything that needs a hook, SWR, or
 * `window` belongs in `earn-program-data.ts`; client callers import the gates
 * from this file directly, never through that client module.
 */

/** Offered providers whose deposits are signed from an SDP custody wallet. */
export const SURFACED_VAULT_DIRECT_EARN_PROVIDERS: readonly EarnProviderId[] =
  SURFACED_EARN_PROVIDERS.filter((provider) => earnDepositStyle(provider) === "vault_direct");

/**
 * Static client-visible gates for opening a vault position. Organization
 * entitlement and provider configuration remain API-authoritative because
 * they are request-scoped and must not be guessed in the browser.
 */
export function earnVaultDepositAvailability(
  strategy: EarnStrategy,
  environment: SdpEnvironment,
  providerAccess: EarnProviderAccess | null
): EarnVaultDepositAvailability {
  // `fundable` is the server's answer to the cluster question and ONLY that
  // question (@sdp/types doc): false is definitive — the instrument does not
  // exist on this environment's cluster. Answered before the generic collapse
  // below, and deliberately first, so a mirrored mainnet row in sandbox
  // (PRO-1742) names the one reason that can never change under it instead of
  // reading as a bare "Unavailable". No cluster comparison happens here — the
  // consumer renders `strategy.hostCluster`, the server derived the verdict.
  if (!strategy.fundable) {
    return "cluster_unavailable";
  }
  if (
    strategy.status !== "active" ||
    earnDepositStyle(strategy.provider) !== "vault_direct" ||
    !isEarnProviderSurfaced(strategy.provider)
  ) {
    return "strategy_unavailable";
  }
  if (!isVaultDirectDepositEnabled(environment, strategy.provider)) {
    return "environment_unavailable";
  }
  if (providerAccess === null) {
    return "access_unavailable";
  }

  // `strategy.provider` is an open read-model string. Surfacing above proves it
  // is a registered provider before this cast; an unknown value already failed
  // closed as `strategy_unavailable`.
  const provider = strategy.provider as EarnProviderId;
  return providerAccess[provider]?.enabled === true ? "available" : "provider_unavailable";
}

/**
 * The ONE environment whose projects may open a deposit with this provider, or
 * `undefined` when neither or both may. "environment_unavailable" is a verdict
 * about the current project; this names the other side so a label can say
 * "Production only" for Jupiter and Ondo instead of the sandbox-era default.
 */
export function earnVaultDepositOnlyEnvironment(provider: string): SdpEnvironment | undefined {
  const sandbox = isVaultDirectDepositEnabled("sandbox", provider);
  const production = isVaultDirectDepositEnabled("production", provider);
  if (sandbox === production) return undefined;
  return sandbox ? "sandbox" : "production";
}
