import { z } from "zod";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "./api-keys";
import {
  CUSTODY_MODES,
  CUSTODY_PROVIDERS,
  CUSTODY_SETUP_REFUSAL_REASONS,
  type CustodyProvider,
} from "./custody";
import { EARN_EXECUTION_MODELS } from "./earn";
import {
  type EarnStrategyParticipation,
  type EarnStrategyParticipationOverrides,
  earnStrategyParticipationOverridesSchema,
  earnStrategyParticipationSchema,
  UNKNOWN_EARN_STRATEGY_PARTICIPATION,
} from "./earn-participation";
import { HASTRA_DEPLOYMENTS } from "./hastra-programs";
import { JUPITER_LEND_EARN_PROGRAM_IDS } from "./jupiter-lend-programs";
import { KAMINO_KVAULT_DEPOSIT_FLOOR_SUPPORT, KAMINO_KVAULT_PROGRAM_IDS } from "./kamino-programs";
import { ONDO_DEPLOYMENTS } from "./ondo-programs";
import type { OrganizationTier } from "./organizations";
import { VEDA_DEPLOYMENTS } from "./veda-programs";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  SOLANA_CLUSTERS,
  type SolanaCluster,
} from "./well-known-tokens";

export const COMPLIANCE_PROVIDERS = ["range", "elliptic", "trm", "chainalysis"] as const;
export type ComplianceProviderId = (typeof COMPLIANCE_PROVIDERS)[number];

export const RAMP_PROVIDERS = ["moonpay", "stripe"] as const;
export type RampProviderId = (typeof RAMP_PROVIDERS)[number];

/**
 * Ramp providers SDP no longer integrates. Their stored transfers, provider
 * accounts and webhook events stay readable, but nothing writes or dispatches
 * to them. A removed provider moves here, and an id is never reused.
 */
export const RETIRED_RAMP_PROVIDERS = [
  "hercle",
  "mural",
  "moneygram",
  "lightspark",
  "coinbase",
  "bvnk",
] as const;
export type RetiredRampProviderId = (typeof RETIRED_RAMP_PROVIDERS)[number];

/** Every provider id a stored ramp row can carry: a live provider or a retired one. */
export const PERSISTED_RAMP_PROVIDERS = [...RAMP_PROVIDERS, ...RETIRED_RAMP_PROVIDERS] as const;
export type PersistedRampProviderId = (typeof PERSISTED_RAMP_PROVIDERS)[number];

export function isRetiredRampProviderId(value: string): value is RetiredRampProviderId {
  return (RETIRED_RAMP_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Vault-infra partners fronting Earn yield strategies.
 *
 * Every executing provider currently uses the **vault-direct** model: Kamino,
 * Veda, Jupiter Lend, Ondo, and the pre-launch WisdomTree integration. They
 * front an on-chain vault or yield-bearing token that an organization custody
 * wallet or an end user's wallet deposits into. Their catalogue client
 * implements the base `EarnVaultProvider` contract; a separate execution
 * package implements `EarnVaultDirectProvider`.
 *
 * Kamino, Veda, and Jupiter Lend use public APIs or on-chain state. Ondo's
 * execution readiness depends on the platform Jupiter key. WisdomTree uses
 * environment-specific Connect credentials. The availability registry owns
 * those distinctions; do not infer credentials from the deposit style.
 */
export const EARN_PROVIDERS = [
  "veda",
  "upshift",
  "perena",
  "kamino",
  "jupiter_lend",
  "ondo",
  "hastra",
  "wisdomtree",
  "plume",
] as const;
export type EarnProviderId = (typeof EARN_PROVIDERS)[number];

/**
 * How money reaches a provider's vault — the shape of its deposit, not whether
 * it is offered.
 *
 * - `custodial` — SDP provisions a provider-managed portfolio wallet and the
 *   customer funds THAT address. SDP never signs; it watches the address and the
 *   provider deploys on its own rebalance. (No current provider uses this.)
 * - `vault_direct`: the position is non-custodial and reached through an
 *   on-chain transaction signed by the organization's selected custody wallet
 *   or an end user's wallet. There is no generic provider deposit
 *   address to fund; SDP builds the transaction and either submits the
 *   custody-signed form or verifies and submits the caller-signed form. Every
 *   current provider uses this shape, including the registered but pre-launch
 *   WisdomTree integration.
 *
 * **The difference is load-bearing in the UI and is not cosmetic.** A custodial
 * program has a real deposit ADDRESS a customer can fund without a provider-built
 * transaction. A vault-direct `providerReference` may be a vault, market, or mint,
 * and presenting it as a send target can destroy or strand funds. Any surface
 * that says "send funds to X" must branch on this.
 *
 * Declared here rather than derived from a provider id at each call site, and
 * exhaustive over `EarnProviderId` so a new provider must state its shape. It
 * records how the provider builds its current on-chain deposit transactions.
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

/**
 * What Solana finality proves for one movement through a provider.
 *
 * `atomic` means the transaction itself delivers the position asset (or, for
 * an exit, the payout). `provider_order` means it submits only the
 * provider-facing leg; the provider strikes and delivers later.
 */
export type EarnMovementSettlement = "atomic" | "provider_order";

/** A provider-declared tolerance a slippage floor is derived from. */
export interface EarnSlippageFloor {
  defaultToleranceBps: number;
}

/** Whether a provider's deposit can encode a share floor at all. */
export type EarnDepositFloorSupport = "enforceable" | "unsupported";

/**
 * Everything SDP declares about one Earn provider.
 *
 * Every per-provider policy table in this module is a column of
 * `EARN_PROVIDER_DESCRIPTORS`, so registering a provider is one entry and the
 * compiler rejects one with a field missing.
 */
export interface EarnProviderDescriptor {
  /**
   * Offered providers appear in discovery and accept new deposits. Existing
   * positions and exits remain readable when a provider is hidden, and
   * catalogue sync and metrics refresh continue independently of surfacing.
   */
  readonly surfaced: boolean;
  /** Informational provider defaults; strategy facts may override them. */
  readonly participation: EarnStrategyParticipation;
  /** How money reaches the provider's vault; see `EARN_DEPOSIT_STYLES`. */
  readonly depositStyle: EarnDepositStyle;
  /**
   * What Solana finality proves for a deposit: `provider_order` means the
   * transaction pays the provider and the provider strikes shares later.
   */
  readonly depositSettlement: EarnMovementSettlement;
  /**
   * What Solana finality proves for a withdrawal. Declared apart from the
   * deposit even where today's values match: a provider can add an atomic exit
   * without changing how subscriptions settle.
   */
  readonly withdrawalSettlement: EarnMovementSettlement;
  /**
   * Dashboard slippage-floor policy for `vault_direct` deposits.
   *
   * A value says the provider's deposit builder REQUIRES an explicit
   * `minSharesOut` — it refuses an implicit tolerance — and that the provider
   * quotes deposits (`supportsVaultDepositQuote`), so the dashboard derives the
   * floor from a LIVE quote: `quotedShares × (1 − toleranceBps/10⁴)`. Never from
   * the deposit amount — that arithmetic is only right while the share rate
   * happens to be 1:1, and stops being right the day yield accrues into the
   * rate. The tolerance covers exactly what it can: the rate moving between the
   * quote and the transaction landing.
   *
   * `null` means the PROVIDER declares no tolerance of its own. It is not the
   * whole answer: `earnDepositSlippagePolicy` also folds in environment and
   * whether the provider can encode a floor at all. Read that function, never
   * this field, to decide whether a build needs `minSharesOut`.
   */
  readonly depositSlippageFloor: EarnSlippageFloor | null;
  /**
   * Whether the provider can encode a deposit share floor at all. WisdomTree's
   * subscription transaction sends USDC before the transfer agent strikes NAV,
   * so no Solana instruction can enforce `minSharesOut` for that later event.
   */
  readonly depositFloorSupport: EarnDepositFloorSupport;
  /**
   * The EXIT twin of `depositSlippageFloor`: the provider's withdrawal builder
   * requires an explicit `minAmountOut` and quotes exits
   * (`supportsVaultWithdrawQuote`), so the dashboard derives the floor from a
   * live quote — `quotedAssets × (1 − toleranceBps/10⁴)` — never from the share
   * count. Declared separately because the two directions are separate
   * capabilities with separate builders: Kamino carries withdrawals today with
   * no floor contract at all, and folding the declarations together would let a
   * provider inherit an exit policy from its deposit one.
   */
  readonly withdrawSlippageFloor: EarnSlippageFloor | null;
  /**
   * Clusters where the provider has a deployment SDP can execute against,
   * DERIVED from the provider's own program or deployment table so the two can
   * never disagree. Filling `VEDA_DEPLOYMENTS["mainnet-beta"]` (PRO-1777)
   * opened Veda to production here with no second edit; Jupiter Lend and Ondo
   * stay mainnet-only for as long as their tables say so.
   */
  readonly deployedClusters: readonly SolanaCluster[];
}

/** The clusters where a per-cluster deployment table names a deployment. */
function deployedClusters(
  table: Readonly<Record<SolanaCluster, unknown>>
): readonly SolanaCluster[] {
  return SOLANA_CLUSTERS.filter((cluster) => table[cluster] != null);
}

/**
 * Upshift and Perena are registered so the sync and the registry-consistency
 * test have an entry, but never implemented: their clients throw
 * NOT_IMPLEMENTED and they catalogue nothing, so there is nothing to offer.
 * They implement no portfolio-wallet capability either, so SDP holds no
 * fundable address for them and must not imply one — `vault_direct` is the
 * answer that promises nothing, not a claim about how they will eventually
 * work. Whoever implements one flips its deposit style and the capability
 * together; the drift test fails until they agree. With no client and no
 * deployment anywhere, they take deposits nowhere.
 */
const UNIMPLEMENTED_PROVIDER = {
  surfaced: false,
  participation: UNKNOWN_EARN_STRATEGY_PARTICIPATION,
  depositStyle: "vault_direct",
  depositSettlement: "atomic",
  withdrawalSettlement: "atomic",
  depositSlippageFloor: null,
  depositFloorSupport: "enforceable",
  withdrawSlippageFloor: null,
  deployedClusters: [],
} as const satisfies EarnProviderDescriptor;

export const EARN_PROVIDER_DESCRIPTORS = {
  veda: {
    // Surfaced 2026-08-31: the Veda vault-direct integration is live — the
    // catalogue half reads vaults on chain (@sdp/earn), the execution half builds
    // deposits and withdrawals (@sdp/veda).
    //
    // The shelf follows `VEDA_DEPLOYMENTS` (@sdp/types/veda-programs): devnet is
    // confirmed, so SANDBOX carries the Test Vault; production carries the
    // separately deployed USDC PRIME and OUSD PRIME vaults.
    // Surfacing decides whether rows REACH customers,
    // never whether any exist.
    surfaced: true,
    participation: {
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: true,
      termsUrl: "https://veda.tech/terms",
    },
    // Implemented: a non-custodial BoringVault deposit signed from the
    // organization's custody wallet, same shape as Kamino. Not a stub's
    // placeholder — `@sdp/veda` builds the instruction and implements no
    // portfolio-wallet capability, which is what the drift test asserts.
    depositStyle: "vault_direct",
    depositSettlement: "atomic",
    withdrawalSettlement: "atomic",
    depositSlippageFloor: { defaultToleranceBps: 10 },
    depositFloorSupport: "enforceable",
    withdrawSlippageFloor: { defaultToleranceBps: 10 },
    deployedClusters: deployedClusters(VEDA_DEPLOYMENTS),
  },
  upshift: {
    ...UNIMPLEMENTED_PROVIDER,
    participation: {
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: true,
      termsUrl: "https://docs.upshift.finance/resources/legal/terms-of-use",
    },
  },
  perena: {
    ...UNIMPLEMENTED_PROVIDER,
    participation: {
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: true,
      termsUrl: "https://perena.gitbook.io/perena/legal/terms-of-use",
    },
  },
  kamino: {
    surfaced: true,
    participation: {
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: true,
      termsUrl: "https://kamino.com/terms",
    },
    depositStyle: "vault_direct",
    depositSettlement: "atomic",
    withdrawalSettlement: "atomic",
    // Kamino deposits carry a caller-chosen minSharesOut wherever the vault
    // program can enforce one. Kamino exposes a live deposit quote, so every
    // consumer derives the floor from quoted shares instead of guessing from the
    // token amount. Enforcement is per CLUSTER, not per provider: the devnet
    // program lacks the floor instruction (`KAMINO_KVAULT_DEPOSIT_FLOOR_SUPPORT`),
    // and `earnDepositSlippagePolicy` answers null there rather than publishing a
    // floor the build would be rejected for.
    depositSlippageFloor: { defaultToleranceBps: 10 },
    depositFloorSupport: "enforceable",
    withdrawSlippageFloor: null,
    deployedClusters: deployedClusters(KAMINO_KVAULT_PROGRAM_IDS),
  },
  jupiter_lend: {
    // Jupiter Earn is a mainnet-only, public on-chain market. Its USDT row is
    // visible in both product catalogues; the sandbox copy is browse-only while
    // production projects may execute against the mainnet program.
    surfaced: true,
    participation: {
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: true,
      // Provider terms; Lend also presents product service terms in its app.
      termsUrl: "https://developers.jup.ag/docs/legal/terms-of-use",
    },
    depositStyle: "vault_direct",
    depositSettlement: "atomic",
    withdrawalSettlement: "atomic",
    depositSlippageFloor: { defaultToleranceBps: 10 },
    depositFloorSupport: "enforceable",
    withdrawSlippageFloor: { defaultToleranceBps: 10 },
    deployedClusters: deployedClusters(JUPITER_LEND_EARN_PROGRAM_IDS),
  },
  ondo: {
    // Hidden while new USDY exposure is paused. Catalogue and metrics sync keep
    // running; existing positions retain the reverse-swap withdrawal adapter.
    // The production catalogue carries mainnet USDY and the sandbox mirror
    // remains stored. Re-enabling this flag needs no catalogue reset.
    surfaced: false,
    participation: {
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: true,
      termsUrl: "https://docs.ondo.finance/legal/terms-of-service",
    },
    // Non-custodial like Kamino/Veda, though the "vault" is the open market:
    // the deposit is a custody-signed USDC→USDY swap and the position is the
    // USDY balance in the organization's own wallet. There is no address to
    // fund, so `vault_direct` is the truthful shape here too.
    depositStyle: "vault_direct",
    depositSettlement: "atomic",
    withdrawalSettlement: "atomic",
    // The deposit is a market swap, so its builder REQUIRES an explicit floor
    // and quotes live (`supportsVaultDepositQuote`). 50 bps default: USDC↔USDY
    // is a stable-ish pair but a real market — wider than Veda's oracle-rate 10
    // so an ordinary spread move between quote and landing does not fail the
    // deposit, still tight enough to bound what a route can take.
    depositSlippageFloor: { defaultToleranceBps: 50 },
    depositFloorSupport: "enforceable",
    // The exit is the reverse market swap; same floor contract as the deposit.
    withdrawSlippageFloor: { defaultToleranceBps: 50 },
    deployedClusters: deployedClusters(ONDO_DEPLOYMENTS),
  },
  hastra: {
    // Registered WIP. SDP has verified only Hastra's mainnet token/config
    // deployment, so sandbox will eventually receive a browse-only mirror while
    // production execution remains gated on the integration's end-to-end release
    // review. Flip this last, per the Earn provider playbook; exits stay
    // registered while it is false.
    surfaced: false,
    participation: {
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: true,
      termsUrl: "https://hastra.io/terms",
    },
    // One owner-signed transaction performs USDC -> wYLDS -> PRIME. Hastra does
    // not expose a deposit address and never takes custody of the signing key.
    depositStyle: "vault_direct",
    // The ordinary deposit transaction mints wYLDS and stakes it for PRIME in
    // the same Solana transaction; there is no provider order after finality.
    depositSettlement: "atomic",
    // When the optional DEX rail is admitted, PRIME -> wYLDS -> USDC completes
    // in one transaction. Hastra's default at-par operator redemption uses its
    // separate asynchronous lifecycle and does not change those atomic-movement
    // reconciliation semantics.
    withdrawalSettlement: "atomic",
    // Hastra v0.0.6 deposit instructions carry no caller-supplied output floor.
    // `depositFloorSupport` keeps production's default policy from inventing
    // one the on-chain programs cannot enforce.
    depositSlippageFloor: null,
    depositFloorSupport: "unsupported",
    // When the optional DEX rail is enabled, PRIME is redeemed to wYLDS and the
    // second leg is a live Jupiter market swap. Its builder requires this bound
    // on final USDC output; runtime surfaces hide it while that rail is off.
    withdrawSlippageFloor: { defaultToleranceBps: 50 },
    deployedClusters: deployedClusters(HASTRA_DEPLOYMENTS),
  },
  wisdomtree: {
    // Registered ahead of launch: catalogue, execution client and eligibility
    // checks are integrated, but the go-live gate (playbook §4: flip LAST, in its
    // own PR, after an end-to-end deposit works) has not been passed — WisdomTree
    // is Solana-mainnet-only, so that E2E is blocked on production vault deposits
    // opening (PRO-1703) and on real WisdomTree Connect credentials.
    surfaced: false,
    participation: {
      requiresKyc: true,
      requiresKyb: true,
      geographicallyRestricted: true,
      termsUrl: "https://app.wisdomtreeconnect.com/web/order/terms-and-conditions",
    },
    // WisdomTree's on-receipt deposit wallet LOOKS like a fundable address, but
    // presenting it as one would strand money: attribution runs through the
    // SENDING wallet's KYC registration, so USDC from an unregistered wallet is
    // not a subscription. Money moves only when SDP builds the transfer for an
    // eligibility-checked owner and that owner signs — the vault_direct shape.
    depositStyle: "vault_direct",
    depositSettlement: "provider_order",
    withdrawalSettlement: "provider_order",
    depositSlippageFloor: null,
    depositFloorSupport: "unsupported",
    withdrawSlippageFloor: null,
    // Registered but deliberately not depositable until the organization model
    // and provider-order settlement are release-ready. Mainnet identities live
    // in `wisdomtree-programs.ts`; this is the money-in admission gate.
    deployedClusters: [],
  },
  plume: {
    // Enable only after live cross-chain settlement and recovery validation.
    surfaced: false,
    participation: {
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: true,
      termsUrl: "https://docs.nest.credit/security-and-compliance/terms-and-conditions",
    },
    depositStyle: "vault_direct",
    depositSettlement: "provider_order",
    withdrawalSettlement: "provider_order",
    depositSlippageFloor: null,
    depositFloorSupport: "unsupported",
    withdrawSlippageFloor: null,
    deployedClusters: [],
  },
} as const satisfies Record<EarnProviderId, EarnProviderDescriptor>;

/** One descriptor field for every provider, keyed by provider. */
type EarnProviderColumn<K extends keyof EarnProviderDescriptor> = {
  readonly [P in EarnProviderId]: (typeof EARN_PROVIDER_DESCRIPTORS)[P][K];
};

function descriptorColumn<K extends keyof EarnProviderDescriptor>(field: K): EarnProviderColumn<K> {
  // SAFETY: the entries are built from `EARN_PROVIDERS`, so the keys are exactly
  // `EarnProviderId` and each value is that provider's own descriptor field.
  return Object.fromEntries(
    EARN_PROVIDERS.map((provider) => [provider, EARN_PROVIDER_DESCRIPTORS[provider][field]])
  ) as EarnProviderColumn<K>;
}

/**
 * The descriptor for an OPEN provider string, or `undefined` when it names no
 * registered provider.
 *
 * Provider ids come from open TEXT columns such as `earn_strategies.provider`.
 * `Object.hasOwn`, not `in`: a prototype key like "toString" must not defeat
 * the guard, matching `isEarnProviderId` in @sdp/earn.
 */
function earnProviderDescriptor(provider: string): EarnProviderDescriptor | undefined {
  // SAFETY: `Object.hasOwn` just proved `provider` is a descriptor key.
  return Object.hasOwn(EARN_PROVIDER_DESCRIPTORS, provider)
    ? EARN_PROVIDER_DESCRIPTORS[provider as EarnProviderId]
    : undefined;
}

/** Which registered providers SDP offers (`EarnProviderDescriptor.surfaced`). */
export const EARN_PROVIDER_SURFACING = descriptorColumn("surfaced");
/** Each provider's deposit shape (`EarnProviderDescriptor.depositStyle`). */
export const EARN_PROVIDER_DEPOSIT_STYLE = descriptorColumn("depositStyle");
/** What finality proves for a deposit (`EarnProviderDescriptor.depositSettlement`). */
export const EARN_PROVIDER_DEPOSIT_SETTLEMENT = descriptorColumn("depositSettlement");
/** What finality proves for a withdrawal (`EarnProviderDescriptor.withdrawalSettlement`). */
export const EARN_PROVIDER_WITHDRAWAL_SETTLEMENT = descriptorColumn("withdrawalSettlement");
/** Provider-declared deposit tolerance (`EarnProviderDescriptor.depositSlippageFloor`). */
export const EARN_PROVIDER_DEPOSIT_SLIPPAGE_FLOOR = descriptorColumn("depositSlippageFloor");
/** Whether a deposit floor is encodable (`EarnProviderDescriptor.depositFloorSupport`). */
export const EARN_PROVIDER_DEPOSIT_FLOOR_SUPPORT = descriptorColumn("depositFloorSupport");
/** Provider-declared exit tolerance (`EarnProviderDescriptor.withdrawSlippageFloor`). */
export const EARN_PROVIDER_WITHDRAW_SLIPPAGE_FLOOR = descriptorColumn("withdrawSlippageFloor");
/** Clusters SDP can execute against (`EarnProviderDescriptor.deployedClusters`). */
export const EARN_PROVIDER_DEPLOYED_CLUSTERS = descriptorColumn("deployedClusters");

/**
 * Resolve strategy facts over provider defaults without consulting live admission.
 * Unknown providers inherit unknown requirements, never unrestricted access.
 */
export function earnStrategyParticipation(
  provider: string,
  overrides?: EarnStrategyParticipationOverrides
): EarnStrategyParticipation {
  const defaults =
    earnProviderDescriptor(provider)?.participation ?? UNKNOWN_EARN_STRATEGY_PARTICIPATION;
  if (overrides === undefined) return earnStrategyParticipationSchema.parse(defaults);
  const parsed = earnStrategyParticipationOverridesSchema.parse(overrides);
  // Optional undefined fields inherit; explicit null and false override defaults.
  const defined = Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined)
  );
  return earnStrategyParticipationSchema.parse({ ...defaults, ...defined });
}

/** Unknown providers fail closed because atomicity is a positive settlement claim. */
export function earnProviderDepositSettlement(provider: string): EarnMovementSettlement {
  return earnProviderDescriptor(provider)?.depositSettlement ?? "provider_order";
}

/** Unknown providers fail closed because atomicity is a positive settlement claim. */
export function earnProviderWithdrawalSettlement(provider: string): EarnMovementSettlement {
  return earnProviderDescriptor(provider)?.withdrawalSettlement ?? "provider_order";
}

/**
 * Deposit shape for an OPEN provider string, defaulting to `vault_direct`.
 *
 * The default is the conservative one: `custodial` is the claim that SDP holds a
 * fundable address for this provider, and inventing that for an unrecognized id
 * would put a wrong send target in front of a customer. `vault_direct` promises
 * nothing SDP has to deliver.
 */
export function earnDepositStyle(provider: string): EarnDepositStyle {
  return earnProviderDescriptor(provider)?.depositStyle ?? "vault_direct";
}

/** Unknown providers fail closed to the ordinary enforceable-floor policy. */
export function earnDepositFloorSupport(provider: string): EarnDepositFloorSupport {
  return earnProviderDescriptor(provider)?.depositFloorSupport ?? "enforceable";
}

/** Slippage-floor policy for an OPEN provider string — fails closed to none. */
export function earnDepositSlippageFloor(provider: string): EarnSlippageFloor | null {
  return earnProviderDescriptor(provider)?.depositSlippageFloor ?? null;
}

/**
 * Tolerance a PRODUCTION deposit starts from when its provider declares no
 * floor of its own. 10 bps: a vault share rate moves by accrued yield, not by
 * a market, so the distance between quote and landing is small; the same
 * figure Veda and Jupiter Lend declare for the same kind of instrument.
 */
export const EARN_PRODUCTION_DEPOSIT_DEFAULT_TOLERANCE_BPS = 10;

/**
 * The floor policy a deposit build ENFORCES for one provider in one
 * environment: the one answer to "does this build need `minSharesOut`". The
 * catalogue publishes it as `depositSlippage`; core preparation derives the
 * enforceable floor from the live quote and the selected tolerance.
 *
 * Cluster first: a floor the row's program cannot enforce is no floor, so a
 * Kamino row hosted on a cluster whose kvault build lacks
 * `deposit_with_min_shares_out` (devnet, per `KAMINO_KVAULT_DEPOSIT_FLOOR_SUPPORT`)
 * answers null and the build takes the legacy instruction. Then capability: an
 * asynchronous next-NAV subscription that cannot encode a floor returns null
 * rather than advertising protection it cannot enforce. Then the provider: a
 * builder that refuses an implicit floor requires one in every environment.
 * Then the environment: every production deposit carries a caller-chosen share
 * floor derived from the live quote, because without one a vault deposit
 * accepts any number of shares (the pinned Kamino SDK builds the legacy
 * instruction). Only a sandbox deposit into a provider with no policy of its
 * own takes the live rate.
 *
 * `hostCluster` is the cluster the row's vault lives on. Callers holding the
 * catalogue row pass `host_cluster`; when omitted, the environment's own
 * cluster (`CLUSTER_BY_SDP_ENVIRONMENT`) stands in, which is the cluster a
 * deposit from that environment executes on.
 */
export function earnDepositSlippagePolicy(
  provider: string,
  environment: SdpEnvironment,
  hostCluster?: SolanaCluster
): EarnSlippageFloor | null {
  const cluster = hostCluster ?? CLUSTER_BY_SDP_ENVIRONMENT[environment];
  if (provider === "kamino" && !KAMINO_KVAULT_DEPOSIT_FLOOR_SUPPORT[cluster]) return null;
  if (earnDepositFloorSupport(provider) === "unsupported") return null;
  const declared = earnDepositSlippageFloor(provider);
  if (declared) return declared;
  return environment === "production"
    ? { defaultToleranceBps: EARN_PRODUCTION_DEPOSIT_DEFAULT_TOLERANCE_BPS }
    : null;
}

/** Exit slippage-floor policy for an OPEN provider string — fails closed to none. */
export function earnWithdrawSlippageFloor(provider: string): EarnSlippageFloor | null {
  return earnProviderDescriptor(provider)?.withdrawSlippageFloor ?? null;
}

/** The offered providers, in `EARN_PROVIDERS` order. */
export const SURFACED_EARN_PROVIDERS: readonly EarnProviderId[] = EARN_PROVIDERS.filter(
  (provider) => EARN_PROVIDER_SURFACING[provider]
);

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
  const descriptor = earnProviderDescriptor(provider);
  if (!descriptor) return false;
  // SAFETY: `Object.hasOwn` just proved `environment` is an `SdpEnvironment`.
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment as SdpEnvironment];
  return descriptor.deployedClusters.includes(cluster);
}

/**
 * Fail-closed surfacing check for an OPEN string: an unrecognized id reads as
 * "not offered".
 */
export function isEarnProviderSurfaced(provider: string): boolean {
  return earnProviderDescriptor(provider)?.surfaced ?? false;
}

export type RampProviderSurfacing = boolean | "sandbox";

export const RAMP_PROVIDER_SURFACING: Readonly<Record<RampProviderId, RampProviderSurfacing>> = {
  moonpay: true,
  stripe: true,
};

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

export const ORGANIZATION_PROVIDER_FAMILIES = ["custody", "compliance", "ramps", "earn"] as const;
export type OrganizationProviderFamily = (typeof ORGANIZATION_PROVIDER_FAMILIES)[number];

export interface OrganizationProviderOverrides {
  custody?: Partial<Record<CustodyProvider, boolean>>;
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
  compliance: Record<ComplianceProviderId, ProviderAvailabilityEntry>;
  ramps: Record<RampProviderId, ProviderAvailabilityEntry>;
  earn: Record<EarnProviderId, ProviderAvailabilityEntry>;
}

export interface OrganizationProviderEntitlements {
  custody: Record<CustodyProvider, boolean>;
  compliance: Record<ComplianceProviderId, boolean>;
  ramps: Record<RampProviderId, boolean>;
  earn: Record<EarnProviderId, boolean>;
}

export interface OrganizationProviderAvailabilityResponse {
  tier: OrganizationTier;
  providers: OrganizationProviderAvailability;
}

/**
 * Why the project provider rule refused a provider (or a custody mode) for a
 * project: the custody setup rule's reasons plus the staged-provider checks.
 * Carried as `details.reason` on the refusal and as `reason` in project
 * provider availability.
 */
export const PROJECT_PROVIDER_REFUSAL_REASONS = [
  ...CUSTODY_SETUP_REFUSAL_REASONS,
  "provider_not_in_release_channel",
  "provider_not_offered",
  "provider_not_configured",
] as const;
export type ProjectProviderRefusalReason = (typeof PROJECT_PROVIDER_REFUSAL_REASONS)[number];

const projectProviderRefusalReasonSchema = z.enum(PROJECT_PROVIDER_REFUSAL_REASONS);

/**
 * A ramps, compliance or Earn provider's availability for a project: available,
 * or unavailable with the first check that refused it.
 *
 * @param family - The provider family.
 * @param providers - The family's provider tuple.
 * @returns The family's entry schema, discriminated on `available`.
 */
function stagedProviderAvailabilityEntrySchema<
  const Family extends string,
  const Providers extends readonly [string, ...string[]],
>(family: Family, providers: Providers) {
  return z.discriminatedUnion("available", [
    z.object({
      family: z.literal(family),
      provider: z.enum(providers),
      available: z.literal(true),
    }),
    z.object({
      family: z.literal(family),
      provider: z.enum(providers),
      available: z.literal(false),
      reason: projectProviderRefusalReasonSchema,
    }),
  ]);
}

/**
 * One provider's availability for a project. Custody entries carry the custody
 * modes the project may set the provider up in (`[]` = none) and, for every
 * other mode, the first check that refused it; every other family carries
 * whether the project may use the provider and, when not, why.
 */
export const projectProviderAvailabilityEntrySchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("custody"),
    provider: z.enum(CUSTODY_PROVIDERS),
    modes: z.array(z.enum(CUSTODY_MODES)),
    unavailableModes: z.array(
      z.object({
        mode: z.enum(CUSTODY_MODES),
        reason: projectProviderRefusalReasonSchema,
      })
    ),
  }),
  stagedProviderAvailabilityEntrySchema("compliance", COMPLIANCE_PROVIDERS),
  stagedProviderAvailabilityEntrySchema("ramps", RAMP_PROVIDERS),
  stagedProviderAvailabilityEntrySchema("earn", EARN_PROVIDERS),
]);

export type ProjectProviderAvailabilityEntry = z.infer<
  typeof projectProviderAvailabilityEntrySchema
>;

/**
 * Which published providers a project can use, in
 * `ORGANIZATION_PROVIDER_FAMILIES` order and each family's provider tuple order.
 * Providers outside the deployment's public API are omitted.
 */
export const projectProviderAvailabilitySchema = z.object({
  projectId: z.string(),
  environment: z.enum(SDP_ENVIRONMENTS),
  providers: z.array(projectProviderAvailabilityEntrySchema),
});

export type ProjectProviderAvailability = z.infer<typeof projectProviderAvailabilitySchema>;

/**
 * Whether an organization may use a family's providers when its settings carry
 * no override for them. A family that is on by default is turned off for one
 * organization with a `false` override per provider; a family that is off by
 * default needs a `true` override per provider (for Earn that override is the
 * money-in gate of ADR 0002).
 */
export const PROVIDER_FAMILY_DEFAULT_ENTITLEMENT = {
  custody: true,
  compliance: false,
  ramps: true,
  earn: false,
} as const satisfies Record<OrganizationProviderFamily, boolean>;

function resolveFamilyEntitlements<const Provider extends string>(
  providers: readonly Provider[],
  entitledByDefault: boolean,
  overrides: Partial<Record<Provider, boolean>> | undefined
): Record<Provider, boolean> {
  // SAFETY: the entries are built from `providers`, so the keys are exactly `Provider`.
  return Object.fromEntries(
    providers.map((provider) => [provider, overrides?.[provider] ?? entitledByDefault])
  ) as Record<Provider, boolean>;
}

/**
 * The providers an organization may use: each family's default
 * (`PROVIDER_FAMILY_DEFAULT_ENTITLEMENT`) with the organization's overrides applied.
 */
export function resolveOrganizationProviderEntitlements(
  overrides: OrganizationProviderOverrides | undefined
): OrganizationProviderEntitlements {
  const defaults = PROVIDER_FAMILY_DEFAULT_ENTITLEMENT;
  return {
    custody: resolveFamilyEntitlements(CUSTODY_PROVIDERS, defaults.custody, overrides?.custody),
    compliance: resolveFamilyEntitlements(
      COMPLIANCE_PROVIDERS,
      defaults.compliance,
      overrides?.compliance
    ),
    ramps: resolveFamilyEntitlements(RAMP_PROVIDERS, defaults.ramps, overrides?.ramps),
    earn: resolveFamilyEntitlements(EARN_PROVIDERS, defaults.earn, overrides?.earn),
  };
}
