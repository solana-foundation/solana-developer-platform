import {
  type EarnProviderId,
  type EarnStrategy,
  earnDepositStyle,
  isEarnProviderSurfaced,
  isVaultDirectDepositEnabled,
  type ProviderAvailabilityEntry,
  type SdpEnvironment,
  SURFACED_EARN_PROVIDERS,
} from "@sdp/types";

export type EarnProviderAccess = Readonly<
  Partial<Record<EarnProviderId, ProviderAvailabilityEntry>>
>;

export type EarnVaultDepositAvailability =
  | "available"
  | "strategy_unavailable"
  | "environment_unavailable"
  | "access_unavailable"
  | "provider_unavailable";

/**
 * Which provider this module drives, and whether it is offered.
 *
 * **This file carries no `"use client"` directive, and that is the whole reason
 * it exists.** Both constants used to live in `earn-program-data.ts`, which is a
 * client module — and a Server Component importing a value from a client module
 * receives a client-reference PROXY, not the value. The proxy is an object, so
 * `!EARN_PROGRAM_CREATION_ENABLED` was always `false` and the deposit route's
 * server-side guard silently never fired. Typecheck passes (the types are right)
 * and unit tests pass (they mock the module), so only a browser catches it.
 *
 * Keep server-readable gates here. Anything that needs a hook, SWR, or
 * `window` belongs in `earn-program-data.ts`, which re-exports these values so
 * existing client imports are unchanged.
 */
/**
 * Providers SDP offers that hold money through a PROGRAM — a provider-managed
 * wallet SDP provisions and the customer funds.
 *
 * A list, not a pin, and DERIVED from two declarations in `@sdp/types` rather
 * than hand-set: surfacing says what is offered, `earnDepositStyle` says which
 * of those have a program model. It is `["ground"]` when Ground is surfaced and
 * `[]` today. Nothing here may hardcode a provider id — that is what let an
 * earlier revision filter the org's own positions down to one provider and hide
 * the rest.
 */
export const SURFACED_CUSTODIAL_EARN_PROVIDERS: readonly EarnProviderId[] =
  SURFACED_EARN_PROVIDERS.filter((provider) => earnDepositStyle(provider) === "custodial");

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
  if (
    strategy.status !== "active" ||
    !strategy.fundable ||
    earnDepositStyle(strategy.provider) !== "vault_direct" ||
    !isEarnProviderSurfaced(strategy.provider)
  ) {
    return "strategy_unavailable";
  }
  if (!isVaultDirectDepositEnabled(environment)) {
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

export function isEarnVaultDepositAvailable(
  strategy: EarnStrategy,
  environment: SdpEnvironment,
  providerAccess: EarnProviderAccess | null
): boolean {
  return earnVaultDepositAvailability(strategy, environment, providerAccess) === "available";
}

/**
 * Whether the dashboard offers CREATING a program at all.
 *
 * True when at least one OFFERED provider has a program model. Un-surface every
 * custodial provider and each create affordance disappears — the Deposit run's
 * custodial branch, "Add strategy", "Change strategy" — because the API refuses
 * `POST /programs` for an un-surfaced provider and a button that leads to a 403
 * is worse than no button.
 *
 * Read affordances are deliberately NOT gated on this. The Positions tab reads
 * every program the organization holds, whatever provider it belongs to and
 * whether or not that provider is still offered, so a position taken while a
 * provider was offered keeps every way to be seen and exited (ADR 0002).
 * Un-surfacing closes the door in, never the door out.
 */
export const EARN_PROGRAM_CREATION_ENABLED = SURFACED_CUSTODIAL_EARN_PROVIDERS.length > 0;

/**
 * The provider a NEW program is created with, or `undefined` when none is
 * offered.
 *
 * V1 has at most one custodial provider offered at a time, so "the first" is
 * exact rather than a guess. When a second lands this becomes a user choice, and
 * the compiler points at every call site because they all read this.
 */
export const EARN_PROGRAM_CREATE_PROVIDER: EarnProviderId | undefined =
  SURFACED_CUSTODIAL_EARN_PROVIDERS[0];
