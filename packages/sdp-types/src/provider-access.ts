import type { SdpEnvironment } from "./api-keys";
import { CUSTODY_PROVIDERS, type CustodyProvider } from "./custody";
import { EARN_EXECUTION_MODELS, type EarnPortfolioToken } from "./earn";
import { JUPITER_LEND_EARN_PROGRAM_IDS } from "./jupiter-lend-programs";
import { KAMINO_KVAULT_PROGRAM_IDS } from "./kamino-programs";
import { ONDO_DEPLOYMENTS } from "./ondo-programs";
import {
  normalizeOrganizationTier,
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationRpcProvider,
  type OrganizationTier,
} from "./organizations";
import { VEDA_DEPLOYMENTS } from "./veda-programs";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  SOLANA_CLUSTERS,
  type SolanaCluster,
} from "./well-known-tokens";

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
  "hercle",
] as const;
export type RampProviderId = (typeof RAMP_PROVIDERS)[number];

/**
 * Vault-infra partners fronting Earn yield strategies.
 *
 * All current providers are **vault-direct providers** (Kamino, Veda): they
 * front on-chain vaults that an
 *   organization custody wallet or an end user's external wallet deposits
 *   into. Their catalogue client implements the base `EarnVaultProvider`
 *   contract; a separate execution package implements `EarnVaultDirectProvider`.
 *
 * Kamino and Veda are keyless today: their catalogue and execution paths read
 * public on-chain state, so the API availability service excludes them rather
 * than demanding keys that nothing reads.
 */
export const EARN_PROVIDERS = [
  "veda",
  "upshift",
  "perena",
  "kamino",
  "jupiter_lend",
  "ondo",
] as const;
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
  kamino: [],
  jupiter_lend: [],
  ondo: [],
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
  kamino: true,
  // Jupiter Earn is a mainnet-only, public on-chain market. Its USDT row is
  // visible in both product catalogues; the sandbox copy is browse-only while
  // production projects may execute against the mainnet program.
  jupiter_lend: true,
  // Surfaced 2026-09-14 (PRO-1832), registered dormant 2026-09-02 (PRO-1803).
  // Mainnet-only like Jupiter Lend: the production catalogue carries the USDY
  // row and production projects may execute against it (the deposit is a
  // Jupiter-routed USDC→USDY swap, `@sdp/ondo`); the sandbox copy arrives
  // through the PRO-1742 mirror, browse-only. No `currentApy` until a rate
  // source lands (PRO-1833) — the row renders "—" rather than a derived figure.
  ondo: true,
} as const satisfies Record<EarnProviderId, boolean>;

/**
 * How money reaches a provider's vault — the shape of its deposit, not whether
 * it is offered.
 *
 * - `custodial` — SDP provisions a provider-managed portfolio wallet and the
 *   customer funds THAT address. SDP never signs; it watches the address and the
 *   provider deploys on its own rebalance. (No current provider uses this.)
 * - `vault_direct`: the vault is non-custodial and takes an on-chain program
 *   instruction signed by the organization's selected custody wallet or an end
 *   user's external wallet. There is no provider deposit address to fund; SDP
 *   builds the transaction and either submits the custody-signed form or
 *   verifies and submits the caller-signed form. Kamino and Veda.
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
  kamino: "vault_direct",
  jupiter_lend: "vault_direct",
  // Non-custodial like Kamino/Veda, though the "vault" is the open market:
  // the deposit is a custody-signed USDC→USDY swap and the position is the
  // USDY balance in the organization's own wallet. There is no address to
  // fund, so `vault_direct` is the truthful shape here too.
  ondo: "vault_direct",
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
 * `minSharesOut` — it refuses an implicit tolerance — and that the provider quotes deposits
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
  kamino: null,
  jupiter_lend: { defaultToleranceBps: 10 },
  // The deposit is a market swap, so its builder REQUIRES an explicit floor
  // and quotes live (`supportsVaultDepositQuote`). 50 bps default: USDC↔USDY
  // is a stable-ish pair but a real market — wider than Veda's oracle-rate 10
  // so an ordinary spread move between quote and landing does not fail the
  // deposit, still tight enough to bound what a route can take.
  ondo: { defaultToleranceBps: 50 },
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
  kamino: null,
  jupiter_lend: { defaultToleranceBps: 10 },
  // The exit is the reverse market swap; same floor contract as the deposit.
  ondo: { defaultToleranceBps: 50 },
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

/** The clusters where a per-cluster deployment table names a deployment. */
function deployedClusters(
  table: Readonly<Record<SolanaCluster, unknown>>
): readonly SolanaCluster[] {
  return SOLANA_CLUSTERS.filter((cluster) => table[cluster] != null);
}

/**
 * Clusters each `vault_direct` provider has a deployment SDP can execute
 * against, DERIVED from the provider's own program or deployment table so this
 * can never disagree with it. Filling `VEDA_DEPLOYMENTS["mainnet-beta"]`
 * (PRO-1777) opens Veda to production here with no second edit; Jupiter Lend
 * and Ondo stay mainnet-only for as long as their tables say so.
 *
 * Upshift and Perena are registered placeholders with no client and no
 * deployment anywhere, so they take deposits nowhere.
 *
 * Exhaustive per provider: a provider added to `EARN_PROVIDERS` without an
 * entry here is a compile error.
 */
export const EARN_PROVIDER_DEPLOYED_CLUSTERS = {
  veda: deployedClusters(VEDA_DEPLOYMENTS),
  upshift: [],
  perena: [],
  kamino: deployedClusters(KAMINO_KVAULT_PROGRAM_IDS),
  jupiter_lend: deployedClusters(JUPITER_LEND_EARN_PROGRAM_IDS),
  ondo: deployedClusters(ONDO_DEPLOYMENTS),
} as const satisfies Record<EarnProviderId, readonly SolanaCluster[]>;

/**
 * Whether a provider's non-custodial vault deposit may be opened from a
 * project in `environment`: the environment's cluster
 * (`CLUSTER_BY_SDP_ENVIRONMENT`: sandbox is devnet, production is mainnet-beta)
 * must carry one of the provider's deployments. So a mainnet vault is
 * depositable from a production project only, whichever provider fronts it,
 * while sandbox keeps browsing the mirrored mainnet shelf read-only.
 *
 * Withdrawals deliberately do not consult this: an exit must remain open in
 * every environment where a position can exist. Fail-closed for an unknown
 * provider or environment.
 */
export function isVaultDirectDepositEnabled(environment: string, provider: string): boolean {
  if (!Object.hasOwn(CLUSTER_BY_SDP_ENVIRONMENT, environment)) return false;
  if (!Object.hasOwn(EARN_PROVIDER_DEPLOYED_CLUSTERS, provider)) return false;
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment as SdpEnvironment];
  const clusters = EARN_PROVIDER_DEPLOYED_CLUSTERS[
    provider as EarnProviderId
  ] as readonly SolanaCluster[];
  return clusters.includes(cluster);
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
  // Sandbox only: the wire contract is proven end to end, but settlement still runs on
  // simulated bank rails, so a production surface would offer a corridor that cannot settle.
  hercle: "sandbox",
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
