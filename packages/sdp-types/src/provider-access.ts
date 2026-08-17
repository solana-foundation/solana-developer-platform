import { CUSTODY_PROVIDERS, type CustodyProvider } from "./custody";
import {
  normalizeOrganizationTier,
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationRpcProvider,
  type OrganizationTier,
} from "./organizations";

export const COMPLIANCE_PROVIDERS = ["range", "elliptic", "trm", "chainalysis"] as const;
export type ComplianceProviderId = (typeof COMPLIANCE_PROVIDERS)[number];

export const RAMP_PROVIDERS = [
  "moonpay",
  "lightspark",
  "bvnk",
  "moneygram",
  "coinbase",
  "mural",
  "stripe",
] as const;
export type RampProviderId = (typeof RAMP_PROVIDERS)[number];

/**
 * Vault-infra partners fronting Earn yield strategies.
 *
 * Two shapes live here and the difference is load-bearing:
 *
 * - **Custodial portfolio providers** (Ground) front an omnibus wallet SDP
 *   provisions and moves money through. They implement the optional
 *   `EarnPortfolioWalletProvider` capability.
 * - **Catalogue-only providers** (Kamino) front on-chain vaults the customer's
 *   own wallet deposits into. They implement the base `EarnVaultProvider`
 *   contract and nothing else, so every money-moving route answers 501 for
 *   them by capability detection — never by a provider-id check.
 *
 * Kamino is also the first provider with NO credential: its data API is public,
 * which is why `keyPairCredentialDefinition` in the API's availability service
 * excludes it rather than demanding a `KAMINO_API_KEY` that nothing reads.
 */
export const EARN_PROVIDERS = ["veda", "upshift", "perena", "ground", "kamino"] as const;
export type EarnProviderId = (typeof EARN_PROVIDERS)[number];

/**
 * Whether SDP currently OFFERS a registered Earn provider — the one switch that
 * decides whether it reaches customers at all.
 *
 * Registration and surfacing are separate questions. `EARN_PROVIDERS` above is
 * "what this deployment can talk to"; this is "what we are selling today". A
 * provider flipped to `false` keeps its client, its credentials, its crons and
 * its catalogue rows — it simply stops being offered:
 *
 * - `GET /strategies` list and detail omit its rows. Hiding it once at the API
 *   covers the dashboard AND every partner integration, because the API is the
 *   surface they all read; a browser-side copy would drift.
 * - `POST /programs` refuses to open a NEW position with it.
 * - The dashboard drops its create affordances (`EARN_PROGRAM_CREATION_ENABLED`).
 *
 * What it deliberately does NOT touch, and this is the load-bearing half:
 *
 * - **Every money-OUT and existing-program route ignores it** — reads,
 *   withdrawal previews, withdrawals, the ledger, and re-targeting a program
 *   that already exists. Un-surfacing gates the way IN only, so it can never
 *   trap funds (ADR 0002's exit-safety invariant). An organization holding a
 *   position with an un-surfaced provider keeps full access to it.
 * - **The catalogue sync and metrics refresh keep running**, so `earn_strategies`
 *   stays a truthful provider inventory and re-surfacing takes effect on deploy
 *   rather than after the next hourly pass. Same reasoning as
 *   `HIDDEN_STRATEGY_TERMS` in the API: filter at the policy boundary, never by
 *   refusing to store what a provider reports.
 *
 * Exhaustive over `EarnProviderId` on purpose: a provider added to
 * `EARN_PROVIDERS` without an entry here is a compile error, so "we registered a
 * provider and never decided whether it was public" cannot happen quietly.
 */
export const EARN_PROVIDER_SURFACING = {
  // Registered so the sync and the registry-consistency test have an entry, but
  // never implemented — their clients throw NOT_IMPLEMENTED and they catalogue
  // nothing, so there is nothing to offer.
  veda: false,
  upshift: false,
  perena: false,
  // Un-surfaced 2026-08-14: SDP is leading with the Kamino catalogue. Ground's
  // client, sandbox/production credentials, catalogue sync and every program
  // route stay live — an organization already holding a Ground program keeps
  // read, re-target, withdrawal and ledger access untouched.
  ground: false,
  kamino: true,
} as const satisfies Record<EarnProviderId, boolean>;

/**
 * How money reaches a provider's vault — the shape of its deposit, not whether
 * it is offered.
 *
 * - `custodial` — SDP provisions a provider-managed portfolio wallet and the
 *   customer funds THAT address. SDP never signs; it watches the address and the
 *   provider deploys on its own rebalance. Ground.
 * - `vault_direct` — the vault is non-custodial and takes deposits straight from
 *   the customer's own wallet, as an on-chain program instruction. There is no
 *   SDP-side address to fund and no SDP-side signature. Kamino.
 *
 * **The difference is load-bearing in the UI and is not cosmetic.** A custodial
 * program has a real deposit ADDRESS a customer can send USDC to. A K-Vault does
 * not: its `providerReference` is the vault's program account, and presenting it
 * as a send target would destroy funds. Any surface that says "send funds to X"
 * must branch on this.
 *
 * Declared here rather than derived from a provider id at each call site, and
 * exhaustive over `EarnProviderId` so a new provider must state its shape. It
 * mirrors — and must agree with — the server-side `supportsPortfolioWallets`
 * capability, which the dashboard cannot see; a drift test in apps/sdp-api
 * asserts the two never disagree.
 */
export const EARN_DEPOSIT_STYLES = ["custodial", "vault_direct"] as const;
export type EarnDepositStyle = (typeof EARN_DEPOSIT_STYLES)[number];

export const EARN_PROVIDER_DEPOSIT_STYLE = {
  // Stubs. They implement no portfolio-wallet capability, so SDP holds no
  // fundable address for them and must not imply one — `vault_direct` is the
  // answer that promises nothing, not a claim about how they will eventually
  // work. Whoever implements one flips this and the capability together; the
  // drift test fails until they agree.
  veda: "vault_direct",
  upshift: "vault_direct",
  perena: "vault_direct",
  ground: "custodial",
  kamino: "vault_direct",
} as const satisfies Record<EarnProviderId, EarnDepositStyle>;

/**
 * Deposit shape for an OPEN provider string, defaulting to `vault_direct`.
 *
 * The default is the conservative one: `custodial` is the claim that SDP holds a
 * fundable address for this provider, and inventing that for an unrecognized id
 * would put a wrong send target in front of a customer. `vault_direct` promises
 * nothing SDP has to deliver.
 */
export function earnDepositStyle(provider: string): EarnDepositStyle {
  return Object.hasOwn(EARN_PROVIDER_DEPOSIT_STYLE, provider)
    ? EARN_PROVIDER_DEPOSIT_STYLE[provider as EarnProviderId]
    : "vault_direct";
}

/** The offered providers, in `EARN_PROVIDERS` order. */
export const SURFACED_EARN_PROVIDERS: readonly EarnProviderId[] = EARN_PROVIDERS.filter(
  (provider) => EARN_PROVIDER_SURFACING[provider]
);

/**
 * Fail-closed surfacing check for an OPEN string.
 *
 * Provider ids reach this from `earn_strategies.provider` and
 * `earn_provider_wallets.provider`, TEXT columns a newer deploy may have
 * written, so an unrecognized id must read as "not offered" rather than index
 * into the map. `Object.hasOwn`, not `in`: a prototype key like "toString" must
 * not defeat the guard — the same rule `isEarnProviderId` follows in @sdp/earn.
 */
export function isEarnProviderSurfaced(provider: string): boolean {
  return (
    Object.hasOwn(EARN_PROVIDER_SURFACING, provider) &&
    EARN_PROVIDER_SURFACING[provider as EarnProviderId]
  );
}

export const ORGANIZATION_PROVIDER_FAMILIES = [
  "custody",
  "rpc",
  "compliance",
  "ramps",
  "earn",
] as const;
export type OrganizationProviderFamily = (typeof ORGANIZATION_PROVIDER_FAMILIES)[number];

export interface OrganizationProviderOverrides {
  custody?: Partial<Record<CustodyProvider, boolean>>;
  rpc?: Partial<Record<OrganizationRpcProvider, boolean>>;
  compliance?: Partial<Record<ComplianceProviderId, boolean>>;
  ramps?: Partial<Record<RampProviderId, boolean>>;
  earn?: Partial<Record<EarnProviderId, boolean>>;
}

export interface ProviderAvailabilityEntry {
  entitled: boolean;
  configured: boolean;
  enabled: boolean;
}

export interface OrganizationProviderAvailability {
  custody: Record<CustodyProvider, ProviderAvailabilityEntry>;
  rpc: Record<OrganizationRpcProvider, ProviderAvailabilityEntry>;
  compliance: Record<ComplianceProviderId, ProviderAvailabilityEntry>;
  ramps: Record<RampProviderId, ProviderAvailabilityEntry>;
  earn: Record<EarnProviderId, ProviderAvailabilityEntry>;
}

export interface OrganizationProviderEntitlements {
  custody: Record<CustodyProvider, boolean>;
  rpc: Record<OrganizationRpcProvider, boolean>;
  compliance: Record<ComplianceProviderId, boolean>;
  ramps: Record<RampProviderId, boolean>;
  earn: Record<EarnProviderId, boolean>;
}

export interface OrganizationProviderAvailabilityResponse {
  tier: OrganizationTier;
  providers: OrganizationProviderAvailability;
}

function createBooleanRecord<const T extends readonly string[]>(
  values: T,
  enabledValues: readonly T[number][]
): Record<T[number], boolean> {
  const enabledSet = new Set<string>(enabledValues);

  return Object.fromEntries(values.map((value) => [value, enabledSet.has(value)])) as Record<
    T[number],
    boolean
  >;
}

function applyOverrides<T extends string>(
  base: Record<T, boolean>,
  overrides?: Partial<Record<T, boolean>>
): Record<T, boolean> {
  if (!overrides) {
    return { ...base };
  }

  const next = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "boolean") {
      continue;
    }
    if (key in next) {
      next[key as T] = value;
    }
  }

  return next;
}

export const GENERAL_PROVIDER_DEFAULTS: OrganizationProviderEntitlements = {
  custody: createBooleanRecord(CUSTODY_PROVIDERS, ["privy", "coinbase_cdp", "para", "turnkey"]),
  rpc: createBooleanRecord(ORGANIZATION_RPC_PROVIDERS, ORGANIZATION_RPC_PROVIDERS),
  compliance: createBooleanRecord(COMPLIANCE_PROVIDERS, []),
  ramps: createBooleanRecord(RAMP_PROVIDERS, RAMP_PROVIDERS),
  earn: createBooleanRecord(EARN_PROVIDERS, []),
};

export function resolveOrganizationProviderEntitlements(input: {
  tier: string | null | undefined;
  providerOverrides?: OrganizationProviderOverrides | null;
}): { tier: OrganizationTier; providers: OrganizationProviderEntitlements } {
  const tier = normalizeOrganizationTier(input.tier);
  // `tier` is retained in the response for backwards compatibility, but provider
  // access is organization-scoped: general providers are available to every org,
  // while manual providers require an explicit provider override.
  const defaults = GENERAL_PROVIDER_DEFAULTS;

  return {
    tier,
    providers: {
      custody: applyOverrides(defaults.custody, input.providerOverrides?.custody),
      rpc: applyOverrides(defaults.rpc, input.providerOverrides?.rpc),
      compliance: applyOverrides(defaults.compliance, input.providerOverrides?.compliance),
      ramps: applyOverrides(defaults.ramps, input.providerOverrides?.ramps),
      earn: applyOverrides(defaults.earn, input.providerOverrides?.earn),
    },
  };
}
