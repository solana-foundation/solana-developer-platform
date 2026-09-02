import type { SdpEnvironment } from "./api-keys";
import { CUSTODY_PROVIDERS, type CustodyProvider } from "./custody";
import { EARN_EXECUTION_MODELS, type EarnPortfolioToken } from "./earn";
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
 * Portfolio-withdrawal tokens each provider can pay to a Solana address.
 *
 * This is exhaustive and shared because the provider client must reject an
 * impossible rail before calling upstream while the dashboard must never
 * offer that same impossible choice. Empty means SDP exposes no program-style
 * Solana payout capability for the provider.
 */
export const EARN_PROGRAM_SOLANA_PAYOUT_TOKENS = {
  veda: [],
  upshift: [],
  perena: [],
  ground: ["usdc"],
  kamino: [],
} as const satisfies Record<EarnProviderId, readonly EarnPortfolioToken[]>;

/** Fail closed for provider ids from open database read models. */
export function earnProgramSolanaPayoutTokens(provider: string): readonly EarnPortfolioToken[] {
  return Object.hasOwn(EARN_PROGRAM_SOLANA_PAYOUT_TOKENS, provider)
    ? EARN_PROGRAM_SOLANA_PAYOUT_TOKENS[provider as EarnProviderId]
    : [];
}

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
  // Surfaced 2026-08-31: the Veda vault-direct integration is live — the
  // catalogue half reads vaults on chain (@sdp/earn), the execution half builds
  // deposits and withdrawals (@sdp/veda).
  //
  // The shelf follows `VEDA_DEPLOYMENTS` (@sdp/types/veda-programs): devnet is
  // confirmed, so the SANDBOX catalogue carries Veda's devnet Test Vault;
  // mainnet is deliberately null, so every production pass reports
  // PROVIDER_NOT_CONFIGURED and the production shelf stays empty until Veda
  // names a production vault. Surfacing decides whether rows REACH customers,
  // never whether any exist.
  veda: true,
  // Registered so the sync and the registry-consistency test have an entry, but
  // never implemented — their clients throw NOT_IMPLEMENTED and they catalogue
  // nothing, so there is nothing to offer.
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
 * - `vault_direct` — the vault is non-custodial and takes an on-chain program
 *   instruction signed by the organization's selected custody wallet. There is
 *   no provider deposit address to fund; SDP builds and submits the custody-
 *   signed transaction. Kamino.
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
 *
 * ── One vocabulary, not two that happen to match (PRO-1705) ───────────────
 * A provider's deposit style IS the execution model every movement through it
 * is executed by, so this is `EARN_EXECUTION_MODELS` under the name that reads
 * correctly when the subject is a provider rather than a movement. The ledger's
 * `execution_model` column and this const therefore cannot drift apart.
 *
 * The aliasing is deliberate but not free: `EarnDepositStyle` and
 * `EarnExecutionModel` are now the SAME type, so the compiler no longer
 * distinguishes "how money reaches this provider" from "how this movement was
 * executed". That is sound precisely because they are one fact — but if a
 * provider ever gains a deposit style that is not an execution model (a second
 * way in to the same on-chain vault, say), this must become its own tuple again
 * rather than gaining a member here.
 */
export const EARN_DEPOSIT_STYLES = EARN_EXECUTION_MODELS;
export type EarnDepositStyle = (typeof EARN_DEPOSIT_STYLES)[number];

export const EARN_PROVIDER_DEPOSIT_STYLE = {
  // Implemented: a non-custodial BoringVault deposit signed from the
  // organization's custody wallet, same shape as Kamino. Not a stub's
  // placeholder — `@sdp/veda` builds the instruction and implements no
  // portfolio-wallet capability, which is what the drift test asserts.
  veda: "vault_direct",
  // Stubs. They implement no portfolio-wallet capability, so SDP holds no
  // fundable address for them and must not imply one — `vault_direct` is the
  // answer that promises nothing, not a claim about how they will eventually
  // work. Whoever implements one flips this and the capability together; the
  // drift test fails until they agree.
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

/**
 * Dashboard slippage-floor policy for `vault_direct` deposits.
 *
 * An entry says the provider's deposit builder REQUIRES an explicit
 * `minSharesOut` — it refuses an implicit tolerance (Veda's SDK throws
 * `SLIPPAGE_PROTECTION_REQUIRED`) — and that the provider quotes deposits
 * (`supportsVaultDepositQuote`), so the dashboard derives the floor from a
 * LIVE quote: `quotedShares × (1 − toleranceBps/10⁴)`. Never from the deposit
 * amount — that arithmetic is only right while the share rate happens to be
 * 1:1, and stops being right the day yield accrues into the rate. The
 * tolerance covers exactly what it can: the rate moving between the quote and
 * the transaction landing.
 *
 * `null` means the dashboard sends no derived floor and renders no slippage
 * control; the provider keeps whatever floor semantics its API contract has.
 * Exhaustive over `EarnProviderId` so a new provider must state its policy.
 */
export const EARN_PROVIDER_DEPOSIT_SLIPPAGE_FLOOR = {
  veda: { defaultToleranceBps: 10 },
  upshift: null,
  perena: null,
  ground: null,
  kamino: null,
} as const satisfies Record<EarnProviderId, { defaultToleranceBps: number } | null>;

/** Slippage-floor policy for an OPEN provider string — fails closed to none. */
export function earnDepositSlippageFloor(provider: string): { defaultToleranceBps: number } | null {
  return Object.hasOwn(EARN_PROVIDER_DEPOSIT_SLIPPAGE_FLOOR, provider)
    ? EARN_PROVIDER_DEPOSIT_SLIPPAGE_FLOOR[provider as EarnProviderId]
    : null;
}

/**
 * The EXIT twin of `EARN_PROVIDER_DEPOSIT_SLIPPAGE_FLOOR`: the provider's
 * withdrawal builder requires an explicit `minAmountOut` and quotes exits
 * (`supportsVaultWithdrawQuote`), so the dashboard derives the floor from a
 * live quote — `quotedAssets × (1 − toleranceBps/10⁴)` — never from the share
 * count. Declared separately because the two directions are separate
 * capabilities with separate builders: Kamino carries withdrawals today with
 * no floor contract at all, and folding the declarations together would let a
 * provider inherit an exit policy from its deposit one.
 */
export const EARN_PROVIDER_WITHDRAW_SLIPPAGE_FLOOR = {
  veda: { defaultToleranceBps: 10 },
  upshift: null,
  perena: null,
  ground: null,
  kamino: null,
} as const satisfies Record<EarnProviderId, { defaultToleranceBps: number } | null>;

/** Exit slippage-floor policy for an OPEN provider string — fails closed to none. */
export function earnWithdrawSlippageFloor(
  provider: string
): { defaultToleranceBps: number } | null {
  return Object.hasOwn(EARN_PROVIDER_WITHDRAW_SLIPPAGE_FLOOR, provider)
    ? EARN_PROVIDER_WITHDRAW_SLIPPAGE_FLOOR[provider as EarnProviderId]
    : null;
}

/** The offered providers, in `EARN_PROVIDERS` order. */
export const SURFACED_EARN_PROVIDERS: readonly EarnProviderId[] = EARN_PROVIDERS.filter(
  (provider) => EARN_PROVIDER_SURFACING[provider]
);

/**
 * Environments where a `vault_direct` deposit may be OPENED.
 *
 * ── Why production is (still) closed ────────────────────────────────────────
 * The vault-withdraw path exists now (PRO-1702: `POST /v1/earn/vault-withdrawals`
 * plus the treasury exit action), and it deliberately does NOT consult this
 * constant — an exit works in every environment a position exists in. What
 * remains open is PRO-1703: the Active tab does not surface vault positions,
 * so a mainnet position would be held somewhere the customer's primary
 * portfolio view cannot show. Entitlement will not save us: it is org-scoped,
 * not environment-scoped, so an entitled org would otherwise reach mainnet
 * before the epic's launch checklist (PRO-1635) says it may.
 *
 * Nothing here traps money that is already deposited — the SDP exit route
 * works in production, and the shares sit in the org's OWN custody wallet —
 * this closes the door IN, which is the only direction ADR 0002 ever permits
 * closing.
 *
 * Shared rather than duplicated on purpose: this is the single fact the API
 * refuses on and the dashboard hides the affordance on, and a UI that offered a
 * button the server refuses is the specific failure this replaces.
 *
 * TO OPEN PRODUCTION: land the Active-tab surfacing (PRO-1703), then add
 * "production" here as part of PRO-1635's launch checklist. It is one line
 * precisely so it cannot be forgotten, and it is not a flag flip precisely
 * because the work is real.
 */
export const VAULT_DIRECT_DEPOSIT_ENVIRONMENTS: readonly SdpEnvironment[] = ["sandbox"];

/**
 * Whether a non-custodial vault deposit may be opened in this environment.
 * Fail-closed: an unrecognized environment answers false.
 */
export function isVaultDirectDepositEnabled(environment: string): boolean {
  return (VAULT_DIRECT_DEPOSIT_ENVIRONMENTS as readonly string[]).includes(environment);
}

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

export type RampProviderSurfacing = boolean | "sandbox";

export const RAMP_PROVIDER_SURFACING = {
  moonpay: true,
  lightspark: true,
  bvnk: true,
  moneygram: "sandbox",
  coinbase: true,
  mural: true,
  stripe: true,
} as const satisfies Record<RampProviderId, RampProviderSurfacing>;

export function isRampProviderSurfaced(provider: string, environment: SdpEnvironment): boolean {
  if (!Object.hasOwn(RAMP_PROVIDER_SURFACING, provider)) {
    return false;
  }
  const surfacing = RAMP_PROVIDER_SURFACING[provider as RampProviderId];
  return surfacing === true || (surfacing === "sandbox" && environment === "sandbox");
}

export function surfacedRampProviders(environment: SdpEnvironment): RampProviderId[] {
  return RAMP_PROVIDERS.filter((provider) => isRampProviderSurfaced(provider, environment));
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
