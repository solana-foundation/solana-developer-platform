import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  EARN_PORTFOLIO_DEPOSIT_STATUSES,
  EARN_PORTFOLIO_POSITION_KINDS,
  EARN_PORTFOLIO_TOKENS,
  EARN_PORTFOLIO_WITHDRAWAL_STATUSES,
  type EarnPortfolioAllocationInput,
  type EarnPortfolioDeposit,
  type EarnPortfolioDepositsPage,
  type EarnPortfolioPosition,
  type EarnPortfolioPositionKind,
  type EarnPortfolioProcessingEstimate,
  type EarnPortfolioTargetAllocations,
  type EarnPortfolioToken,
  type EarnPortfolioWalletActivity,
  type EarnPortfolioWalletSnapshot,
  type EarnPortfolioWalletStatus,
  type EarnPortfolioWithdrawal,
  type EarnPortfolioWithdrawalPreview,
  type EarnPortfolioYield,
  type EarnStrategySourceKind,
  isWellKnownTokenSymbol,
  type SolanaCluster,
  wellKnownMint,
} from "@sdp/types";
import { badRequest, providerNotConfigured } from "../../errors";
import { providerFetchJson } from "../../fetch";
import { bearerAuthHeader } from "../../shared";
import type {
  EarnDeclaredStrategySupport,
  EarnPendingWithdrawalApproval,
  EarnPortfolioAddressBookEntryInput,
  EarnPortfolioAddressBookEntryResult,
  EarnPortfolioDepositsInput,
  EarnPortfolioStrategyUpdateInput,
  EarnPortfolioStrategyUpdateResult,
  EarnPortfolioWalletCreateInput,
  EarnPortfolioWalletCreateResult,
  EarnPortfolioWalletProvider,
  EarnPortfolioWalletRefInput,
  EarnPortfolioWithdrawalCreateInput,
  EarnPortfolioWithdrawalPreviewInput,
  EarnPortfolioWithdrawalStatusInput,
  EarnRuntimeContext,
  EarnWithdrawalApprovalAction,
  EarnWithdrawalApprovalProvider,
  EarnWithdrawalApprovalRequest,
  EarnWithdrawalApprovalRequestInput,
  EarnWithdrawalApprovalVoteInput,
  EarnWithdrawalApprovalVoteResult,
  ProviderStrategySnapshot,
} from "../../types";
import { StubEarnClient } from "../stub";

const GROUND_SANDBOX_API_URL = "https://sandbox.groundtech.co";
const GROUND_PRODUCTION_API_URL = "https://production.groundtech.co";

/**
 * Solana rails per environment — the ONLY chains SDP surfaces to Ground, and
 * this constant is the enforcement point: every wallet flow sends
 * `config.chain` from here, never a caller-supplied chain. Ground confirmed
 * (2026-08-05) that sandbox supports both `ethereum_sepolia` and
 * `solana_devnet`; `solana_devnet` is the chain key for Solana flows in
 * sandbox. SDP's product surface is Solana-only, so the other rails stay
 * provider plumbing we never emit.
 */
const GROUND_SOLANA_CHAINS = { sandbox: "solana_devnet", production: "solana" } as const;

/**
 * Stablecoins Ground routes on its SOLANA rails — a GROUND constraint, not an
 * SDP preference (their supported-chains doc: "Solana = USDC deposits and
 * withdrawals only"; USDT rides Ethereum — mainnet in production, Sepolia in
 * sandbox). A source outside this set can never be funded from or paid out to
 * the Solana addresses SDP surfaces, so `listStrategies` keeps it out of the
 * catalogue on every cluster, withdrawal preview/create refuse it before any
 * network call (`assertSolanaRoutable` — Ground's own rejection is wire text
 * partners can't act on), and the dashboard's withdraw-token whitelist
 * mirrors this set (apps/sdp-web/src/app/dashboard/markets/earn/
 * earn-withdraw-modal.tsx, `SOLANA_PAYOUT_TOKENS`).
 */
const GROUND_SOLANA_ROUTED_TOKENS: ReadonlySet<string> = new Set(["usdc"]);

/**
 * Fail fast on a token Ground cannot route on Solana rails. Gates on a static
 * provider constraint only — never availability or enablement — so it cannot
 * trap funds a withdrawal could otherwise move (ADR 0002): Ground itself
 * refuses these requests, just with provider wire text.
 */
function assertSolanaRoutable(token: EarnPortfolioToken): void {
  if (!GROUND_SOLANA_ROUTED_TOKENS.has(token)) {
    throw badRequest(
      `Ground cannot pay out ${token.toUpperCase()} on Solana — Solana rails carry USDC only`
    );
  }
}

interface GroundConfig {
  baseUrl: string;
  headers: { Authorization: string };
  chain: (typeof GROUND_SOLANA_CHAINS)[keyof typeof GROUND_SOLANA_CHAINS];
}

function readGroundConfig(ctx: EarnRuntimeContext): GroundConfig {
  const sandbox = ctx.environment === "sandbox";
  const apiKey = (sandbox ? ctx.env.GROUND_SANDBOX_API_KEY : ctx.env.GROUND_API_KEY)?.trim();
  if (!apiKey) {
    throw providerNotConfigured(
      sandbox
        ? "Ground sandbox is not configured. Set GROUND_SANDBOX_API_KEY."
        : "Ground is not configured. Set GROUND_API_KEY."
    );
  }
  return {
    baseUrl: sandbox ? GROUND_SANDBOX_API_URL : GROUND_PRODUCTION_API_URL,
    headers: { Authorization: bearerAuthHeader(apiKey) },
    chain: GROUND_SOLANA_CHAINS[ctx.environment],
  };
}

/**
 * Encode a provider reference for use as ONE URL path segment.
 *
 * Every request here carries the platform's Ground API key, and that key is
 * account-wide — one Ground account serves every SDP org. So a reference that
 * reaches the path unencoded is not a broken URL, it is a request-forgery
 * primitive: the WHATWG URL parser resolves `..` segments, so an id of
 * `../../wallets?` turns `/v2/turnkey/activities/<id>/vote` into
 * `/v2/wallets?/vote` — a different, authenticated endpoint. Refs originate
 * variously from the DB, from provider responses, and from request path
 * params, so they are all treated as untrusted here, at the one layer that
 * builds the URL. Encoding (not format validation) is the fix: provider id
 * formats drift, while percent-encoding is correct for any opaque id and
 * leaves UUID-shaped refs byte-identical.
 */
function pathSegment(reference: string, name: string): string {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw badRequest(`Ground ${name} is required`);
  }
  return encodeURIComponent(trimmed);
}

// --- Ground wire shapes (docs.groundtech.co, verified 2026-08-03) ---

interface GroundListResponse<TItem> {
  data: TItem[];
  nextCursor: string | null;
}

interface GroundProcessingPolicy {
  processingTimeBasis: "elapsed_seconds" | "banking_days";
  typicalMinUnits: number;
  typicalMaxUnits: number;
}

export interface GroundYieldSourceAllocation {
  label: string;
  type?: string | null;
  valueUsd?: number | null;
  pct?: number | null;
}

export interface GroundYieldSource {
  id: string;
  name: string;
  /** Documented: active | buy_only | sell_only | emergency_freeze — kept open. */
  mode: string;
  /**
   * Where the yield source ITSELF sits — provider plumbing, deliberately NOT a
   * catalogue gate. SDP's Solana-only mandate is about the rails the customer
   * touches (deposit address, payout address, `depositToken`), not about where
   * Ground routes the capital afterwards: it bridges internally, which is what
   * the `bridge` position kind represents. So an Ethereum-hosted source funded
   * by USDC on Solana is catalogued on purpose. Surfaced for the inventory
   * script, which reports it because "how much of this shelf actually lives on
   * Solana" is a product question the gates alone do not answer.
   */
  chain?: string | null;
  apyBps?: number | null;
  tvlUsd?: number | null;
  utilizationPct?: number | null;
  allocations?: GroundYieldSourceAllocation[] | null;
  protocol?: string | null;
  depositToken: string;
  processingPolicies?: {
    deposit?: GroundProcessingPolicy;
    redeem?: GroundProcessingPolicy;
  } | null;
}

interface GroundTargetWeight {
  yieldSourceId: string;
  targetWeightBps: number;
}

type GroundStrategyAllocations = Partial<Record<string, GroundTargetWeight[]>>;

interface GroundWalletPosition {
  id: string;
  kind: string;
  label: string;
  valueUsd: string;
  pct?: number | null;
  yieldSourceId?: string | null;
  token?: string | null;
}

interface GroundWallet {
  id: string;
  status: string;
  depositAddresses?: Partial<Record<string, string>> | null;
  balance: {
    totalUsd: string;
    withdrawableUsd: string;
    reservedUsd: string;
    earnedUsd: string;
  };
  positions?: GroundWalletPosition[] | null;
  strategyAllocations?: GroundStrategyAllocations | null;
}

interface GroundWalletYieldPosition {
  yieldSourceId: string;
  name: string;
  apyBps?: number | null;
  pct?: number | null;
  deployedValueUsd: string;
}

interface GroundWalletYield {
  walletId: string;
  earnedUsd: string;
  annualizedUsd?: string | null;
  currentBalanceUsd?: string | null;
  positions?: GroundWalletYieldPosition[] | null;
}

interface GroundDeposit {
  id: string;
  amount: string;
  token: string;
  /** Rail the deposit arrived on — gates whether its identifiers surface. */
  chain?: string | null;
  fromAddress?: string | null;
  txHash?: string | null;
  status?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

interface GroundPayoutLegStep {
  state: string;
}

/**
 * Payout legs settle independently and each can gate on its own customer
 * approval (docs: get-withdrawal). Only the statuses matter to SDP — the
 * withdrawal-level `pending_approval` derivation below reads them; every other
 * leg field (labels, tx detail) stays provider plumbing we do not map.
 */
interface GroundPayoutLeg {
  status: string;
  steps?: GroundPayoutLegStep[] | null;
}

interface GroundWithdrawal {
  id: string;
  amountRequestedUsd?: string | null;
  amountPaidUsd?: string | null;
  feeUsd?: string | null;
  destinationAddress: string;
  destinationToken?: string | null;
  status: string;
  failureReason?: string | null;
  payoutLegs?: GroundPayoutLeg[] | null;
  createdAt: string;
  completedAt?: string | null;
}

interface GroundWithdrawalPreview {
  amountRequestedUsd?: string | null;
  feeUsd: string;
  withdrawableUsd: string;
  totalUsdAfterWithdrawal: string;
  processingEstimate?: {
    basis: EarnPortfolioProcessingEstimate["basis"];
    typicalMinDuration: string;
    typicalMaxDuration: string;
  } | null;
}

/**
 * Ground's customer-approval model, empirically resolved 2026-08-05 (sandbox)
 * plus docs.groundtech.co: approval is NOT the default — a withdrawal on an
 * org without an approval policy pays out with no Turnkey activity ever
 * appearing. When a policy IS engaged (production withdrawal limits answer
 * `403 withdrawal_policy_required`), the affected payout leg parks in
 * `pending_customer_approval` and a pending activity shows up here. The stamp
 * comes from the customer-held Turnkey signer, outside Ground and outside SDP:
 * these endpoints only carry payloads and stamps, never keys.
 */
interface GroundTurnkeyActivity {
  turnkeyActivityId: string;
  /** Turnkey vocabulary, e.g. ACTIVITY_STATUS_CONSENSUS_NEEDED — kept open. */
  status: string;
  activityKind?: string | null;
  withdrawalId?: string | null;
  withdrawalLegId?: string | null;
  portfolioWalletId?: string | null;
  destinationChain?: string | null;
  destinationToken?: string | null;
  destinationAddress?: string | null;
  displayAmountNativeUnits?: string | null;
  firstSeenAt?: string;
}

interface GroundTurnkeyApprovalRequest {
  activityId: string;
  action: EarnWithdrawalApprovalAction;
  turnkeyRequest: Record<string, unknown>;
  /** JSON string form of turnkeyRequest — the exact bytes the signer stamps. */
  stampPayload: string;
}

interface GroundTurnkeyVoteResult {
  action: EarnWithdrawalApprovalAction;
  approved?: boolean;
  rejected?: boolean;
  alreadyCompleted?: boolean;
  alreadyTerminal?: boolean;
  status?: string;
  resultStatus?: string | null;
}

// --- Normalization helpers ---

/** Narrow an open provider string to a closed union member, else undefined. */
function narrow<T extends string>(
  values: readonly T[],
  value: string | null | undefined
): T | undefined {
  return values.includes(value as T) ? (value as T) : undefined;
}

/** apyBps 356 → "0.0356" via integer math — no float ever touches a rate. */
function bpsToDecimalString(bps: number): string {
  const whole = Math.trunc(bps / 10_000);
  const fraction = String(Math.abs(Math.trunc(bps)) % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * Blend per-position rates into the program's current APY. Ground reports a
 * rate per yield source and no wallet-level rate, so this derives one the same
 * way their dashboard does: weight by deployed value when anything is deployed,
 * otherwise by target allocation — a funded-but-not-yet-rebalanced program
 * still has a meaningful forward rate. Returns undefined when no position
 * carries weight (e.g. a program held entirely as cash), so callers render
 * "no rate yet" rather than a misleading 0%.
 */
function blendPositionApy(
  positions: readonly { apy: string; pct: number; deployedValueUsd: string }[]
): string | undefined {
  const deployed = positions.map((position) => Number(position.deployedValueUsd) || 0);
  const totalDeployed = deployed.reduce((sum, value) => sum + value, 0);
  const weights = totalDeployed > 0 ? deployed : positions.map((position) => position.pct || 0);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) {
    return undefined;
  }
  const blended = positions.reduce(
    (sum, position, index) => sum + (Number(position.apy) || 0) * (weights[index] ?? 0),
    0
  );
  return (blended / totalWeight).toFixed(6);
}

/**
 * Redeem policy → catalogue liquidity: instant only when the provider reports
 * a zero typical maximum; anything slower rounds UP to whole days so the
 * catalogue never promises faster liquidity than the provider does.
 */
function redeemLiquidity(
  policy: GroundProcessingPolicy | undefined
): Pick<ProviderStrategySnapshot, "liquidityTerm" | "redemptionDelayDays"> {
  if (!policy || policy.typicalMaxUnits === 0) {
    return { liquidityTerm: "instant" };
  }
  const redemptionDelayDays =
    policy.processingTimeBasis === "banking_days"
      ? Math.ceil(policy.typicalMaxUnits)
      : Math.ceil(policy.typicalMaxUnits / 86_400);
  return { liquidityTerm: "delayed", redemptionDelayDays };
}

/**
 * Allocation types that mark a sleeve as real-world assets.
 *
 * Observed against the live sandbox catalogue (18 sources, 2026-08-04), the only
 * `type` values Ground actually emits are `market`, `liquidity`, `loan`,
 * `reserve`, `rwa` and `treasury`. Of those exactly two are RWA and both already
 * match: the Janus Henderson vaults report `rwa` and the Superstate/treasury
 * vaults report `treasury`. Everything else is genuinely DeFi. The extra
 * alternatives below are kept for values Ground documents but has not emitted
 * here; do not add more on speculation — check what the API returns first.
 * Exported for the catalogue-inventory script's allocation-type census, which
 * is how "check what the API returns" happens against each environment.
 */
export const RWA_ALLOCATION_TYPE = /treasur|t.?bill|clo|rwa|bond|credit|note/i;

/**
 * A Ground source is a basket of allocations; classify by the dominant side
 * (weighted by pct when reported, else counted) so a mostly-treasury source
 * reads as RWA even with a small DeFi reserve sleeve. Empty → defi.
 * Exported for the catalogue-inventory script, which classifies sources
 * distillation drops.
 */
export function classifySourceKind(
  allocations: readonly GroundYieldSourceAllocation[] | null | undefined
): EarnStrategySourceKind {
  let rwa = 0;
  let defi = 0;
  for (const allocation of allocations ?? []) {
    const weight = allocation.pct ?? 1;
    if (allocation.type && RWA_ALLOCATION_TYPE.test(allocation.type)) {
      rwa += weight;
    } else {
      defi += weight;
    }
  }
  return rwa > defi ? "rwa" : "defi";
}

/**
 * Curator houses Ground names inside a yield-source id, e.g.
 * `morpho-steakhouse-usdc` or `kamino-gauntlet-frontier-usdc`. This is Ground's
 * naming vocabulary, deliberately NOT `EARN_KNOWN_CURATOR_LABELS`: that
 * registry is display-only, so adding a label there can never change what this
 * derives (a Morpho-hosted vault must resolve to the house curating it, not to
 * Morpho). A new house here is a one-line change; a house we don't list still
 * resolves through the convention or protocol fallback below.
 */
const GROUND_CURATOR_HOUSES = [
  "gauntlet",
  "steakhouse",
  "smokehouse",
  "sentora",
  "allez",
  "rockawayx",
  "august",
] as const;

/**
 * Curator is data, not code (ADR 0002): match a curator house named in the
 * source id/name, then the `<protocol>-<curator>-<token>` convention (open
 * string — an unlisted curator still resolves), then the hosting protocol.
 * Exported for the catalogue-inventory script, which attributes sources
 * distillation drops.
 */
export function deriveCurator(source: GroundYieldSource): string | undefined {
  const id = source.id.toLowerCase();
  const idTokens = id.split(/[^a-z0-9]+/);
  const name = source.name.toLowerCase();
  for (const curator of GROUND_CURATOR_HOUSES) {
    if (idTokens.includes(curator) || name.includes(curator)) {
      return curator;
    }
  }
  const conventional = /^(?:morpho|kamino)-([a-z0-9]+)-(?:usdc|usdt)$/.exec(id);
  if (conventional) {
    return conventional[1];
  }
  return source.protocol?.trim().toLowerCase() || undefined;
}

/** Why distillation kept a raw yield source out of the strategy catalogue. */
export type GroundCatalogueDropReason =
  | "inactive_mode"
  | "not_solana_routable"
  | "unknown_token_symbol"
  | "no_cluster_mint";

export type GroundYieldSourceDistillation =
  | { outcome: "catalogued"; snapshot: ProviderStrategySnapshot }
  | { outcome: "dropped"; reason: GroundCatalogueDropReason };

/**
 * Distill one raw Ground yield source into a catalogue snapshot, or say
 * exactly why it stays out. The single decision point for what enters the
 * catalogue: `listStrategies` collects the catalogued outcomes, and the
 * inventory script (apps/sdp-api/scripts/inventory-ground-catalogue.ts)
 * reports the dropped ones — these gates silently shrink the catalogue, so
 * coverage questions (PRO-1638) need the drops enumerated, not skipped.
 */
export function distillGroundYieldSource(
  source: GroundYieldSource,
  cluster: SolanaCluster
): GroundYieldSourceDistillation {
  // Only fully tradable sources enter the catalogue. buy_only would let
  // deposits into an exit-frozen source — trapped funds, which the Earn
  // pluggability constraint forbids; sell_only/emergency_freeze cannot
  // take deposits at all. Delisting is also how a paused source drains
  // from the depositable set (catalogue-sync re-asserts `active`).
  if (source.mode !== "active") {
    return { outcome: "dropped", reason: "inactive_mode" };
  }
  // A token Ground cannot route on Solana is un-fundable and un-exitable
  // through SDP's Solana-only surface on ANY cluster — never catalogue it
  // (GROUND_SOLANA_ROUTED_TOKENS; this is Ground's rail support, not a
  // cluster/mint question like the check below).
  if (!GROUND_SOLANA_ROUTED_TOKENS.has(source.depositToken.toLowerCase())) {
    return { outcome: "dropped", reason: "not_solana_routable" };
  }
  const symbol = source.depositToken.toUpperCase();
  if (!isWellKnownTokenSymbol(symbol)) {
    return { outcome: "dropped", reason: "unknown_token_symbol" };
  }
  // No mint on this environment's cluster (USDT has no devnet mint) —
  // the strategy cannot be funded here, so keep it out of the catalogue.
  const mint = wellKnownMint(symbol, cluster);
  if (!mint) {
    return { outcome: "dropped", reason: "no_cluster_mint" };
  }

  const curator = deriveCurator(source);
  return {
    outcome: "catalogued",
    snapshot: {
      providerReference: source.id,
      name: source.name,
      sourceKind: classifySourceKind(source.allocations),
      underlyingSource: source.protocol?.trim().toLowerCase() || undefined,
      depositMints: [mint],
      apyType: "variable",
      currentApy: source.apyBps == null ? undefined : bpsToDecimalString(source.apyBps),
      ...redeemLiquidity(source.processingPolicies?.redeem),
      riskMetadata: {
        ...(curator === undefined ? {} : { curator }),
        ...(source.tvlUsd == null ? {} : { tvlUsd: source.tvlUsd }),
        ...(source.utilizationPct == null ? {} : { utilizationPct: source.utilizationPct }),
      },
    },
  };
}

/**
 * THE mapping from Ground's wallet vocabulary to SDP's — the only place in the
 * platform that knows these strings. Each entry carries both facts a consumer
 * needs: whether the wallet can take a mutation (`status`) and, when it is
 * busy, what it is doing (`activity`). Keeping them in one table is what stops
 * a second copy of Ground's vocabulary appearing in a UI that wants to name the
 * operation.
 */
const WALLET_STATE_BY_GROUND_STATUS: Record<
  string,
  { status: EarnPortfolioWalletStatus; activity?: EarnPortfolioWalletActivity }
> = {
  creating: { status: "creating" },
  idle: { status: "ready" },
  withdrawal_active: { status: "busy", activity: "withdrawing" },
  rebalance_active: { status: "busy", activity: "rebalancing" },
  // The withdrawal is the fact a reader is waiting on; a concurrent rebalance
  // is provider housekeeping that implies nothing for them to do.
  withdrawal_and_rebalance_active: { status: "busy", activity: "withdrawing" },
  failed: { status: "failed" },
};

/**
 * Unknown statuses read as `busy` with NO activity: funds stay visible,
 * mutations wait, and nothing claims to know what a status this build has
 * never seen actually means.
 */
function normalizeWalletState(status: string): {
  status: EarnPortfolioWalletStatus;
  activity?: EarnPortfolioWalletActivity;
} {
  return WALLET_STATE_BY_GROUND_STATUS[status] ?? { status: "busy" };
}

/**
 * Position label for SDP's wire types and UI.
 *
 * Ground labels a position with the chain the value currently sits on — e.g.
 * "USDT (Ethereum Sepolia)" for idle cash. SDP's surface is Solana-only
 * (ADR 0002 invariant 5: no other chain's addresses or rails may leak into wire
 * types or UI), and Ground's routing between chains is provider plumbing we
 * never expose, so every kind except `yield_source` gets a label synthesized
 * here from kind + token. `yield_source` keeps the provider's label: that is the
 * vault's product name, carries no chain, and is what a reader matches against
 * the strategy catalogue.
 *
 * The VALUE is never hidden — only the chain wording. Off-rail cash still counts
 * toward the wallet total Ground reports, so dropping the position outright
 * would leave a total its positions do not sum to.
 */
function positionLabel(
  kind: EarnPortfolioPositionKind,
  providerLabel: string,
  token: EarnPortfolioToken | undefined
): string {
  if (kind === "yield_source") {
    return providerLabel;
  }
  const suffix = token ? ` (${token.toUpperCase()})` : "";
  switch (kind) {
    case "cash":
      return `Cash${suffix}`;
    case "bridge":
      return `In transit${suffix}`;
    case "external_payout":
      return `Withdrawal in progress${suffix}`;
    default:
      // `unknown` is the forward-compatible fallback: a kind this build does not
      // recognize could carry anything in its label, so it never passes through.
      return `Other holding${suffix}`;
  }
}

function mapPosition(position: GroundWalletPosition): EarnPortfolioPosition {
  const kind = narrow(EARN_PORTFOLIO_POSITION_KINDS, position.kind) ?? "unknown";
  const token = narrow(EARN_PORTFOLIO_TOKENS, position.token);
  return {
    kind,
    label: positionLabel(kind, position.label, token),
    valueUsd: position.valueUsd,
    pct: position.pct ?? undefined,
    yieldSourceId: position.yieldSourceId ?? undefined,
    token,
  };
}

function mapTargetAllocations(
  allocations: GroundStrategyAllocations | null | undefined
): EarnPortfolioTargetAllocations {
  const mapped: EarnPortfolioTargetAllocations = {};
  for (const token of EARN_PORTFOLIO_TOKENS) {
    const weights = allocations?.[token];
    if (weights) {
      mapped[token] = weights.map(({ yieldSourceId, targetWeightBps }) => ({
        yieldSourceId,
        weightBps: targetWeightBps,
      }));
    }
  }
  return mapped;
}

function mapDeposit(deposit: GroundDeposit, solanaChain: string): EarnPortfolioDeposit {
  // Same rule as position labels and the deposit-address selection, applied to
  // deposit provenance: the VALUE always surfaces, another rail's identifiers
  // never do (ADR 0002 invariant 5). A shared Ground wallet is fundable on
  // non-Solana rails (the sandbox USDT faucet is Sepolia-only), and passing
  // those rows' fields through verbatim put an Ethereum 0x address in the
  // dashboard and an Ethereum tx hash in a field named transactionSignature.
  // Gate on the deposit's own rail; an absent chain withholds the identifiers
  // rather than guessing — the row, amount, token, and status still render.
  const onSolanaRail = deposit.chain === solanaChain;
  return {
    id: deposit.id,
    amountUsd: deposit.amount,
    // Ground only routes the tokens SDP declares, so an undeclared token here
    // is drift; surface it as usdc rather than dropping the funds from view.
    token: narrow(EARN_PORTFOLIO_TOKENS, deposit.token) ?? "usdc",
    status: narrow(EARN_PORTFOLIO_DEPOSIT_STATUSES, deposit.status) ?? "processing",
    fromAddress: onSolanaRail ? (deposit.fromAddress ?? undefined) : undefined,
    transactionSignature: onSolanaRail ? (deposit.txHash ?? undefined) : undefined,
    createdAt: deposit.createdAt,
    completedAt: deposit.completedAt ?? undefined,
  };
}

/**
 * Ground never reports approval-parking at the withdrawal level: the top-level
 * status stays `processing` while the affected payout leg (or a step inside
 * it) sits in `pending_customer_approval` awaiting the customer's Turnkey
 * stamp. Read both levels — the docs put the state in each enum.
 */
function withdrawalAwaitsApproval(withdrawal: GroundWithdrawal): boolean {
  return (withdrawal.payoutLegs ?? []).some(
    (leg) =>
      leg.status === "pending_customer_approval" ||
      (leg.steps ?? []).some((step) => step.state === "pending_customer_approval")
  );
}

function mapWithdrawal(withdrawal: GroundWithdrawal): EarnPortfolioWithdrawal {
  const status = narrow(EARN_PORTFOLIO_WITHDRAWAL_STATUSES, withdrawal.status) ?? "processing";
  return {
    withdrawalRef: withdrawal.id,
    // Fold a parked leg up into the distinct wire status, but never override
    // a terminal status — leg states are history once the withdrawal settles.
    status:
      status === "processing" && withdrawalAwaitsApproval(withdrawal) ? "pending_approval" : status,
    amountRequestedUsd: withdrawal.amountRequestedUsd ?? undefined,
    amountPaidUsd: withdrawal.amountPaidUsd ?? undefined,
    feeUsd: withdrawal.feeUsd ?? undefined,
    token: narrow(EARN_PORTFOLIO_TOKENS, withdrawal.destinationToken),
    destinationAddress: withdrawal.destinationAddress,
    failureReason: withdrawal.failureReason ?? undefined,
    createdAt: withdrawal.createdAt,
    completedAt: withdrawal.completedAt ?? undefined,
  };
}

function mapTurnkeyActivity(activity: GroundTurnkeyActivity): EarnPendingWithdrawalApproval {
  return {
    approvalRef: activity.turnkeyActivityId,
    providerStatus: activity.status,
    kind: activity.activityKind ?? undefined,
    withdrawalRef: activity.withdrawalId ?? undefined,
    withdrawalLegRef: activity.withdrawalLegId ?? undefined,
    providerWalletRef: activity.portfolioWalletId ?? undefined,
    destinationChain: activity.destinationChain ?? undefined,
    destinationToken: activity.destinationToken ?? undefined,
    destinationAddress: activity.destinationAddress ?? undefined,
    amountNativeUnits: activity.displayAmountNativeUnits ?? undefined,
    firstSeenAt: activity.firstSeenAt ?? undefined,
  };
}

const USD_AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

/** Ground speaks JSON doubles for USD amounts; validate before converting. */
function parseUsdAmount(value: string): number {
  const trimmed = value.trim();
  if (!USD_AMOUNT_PATTERN.test(trimmed)) {
    throw badRequest(`Invalid USD amount: ${value}`);
  }
  return Number(trimmed);
}

/**
 * Ground vault-infra client (docs.groundtech.co). Implements the live
 * strategy catalogue plus the full portfolio-wallet capability against
 * Ground's Portfolio Wallets API, and the withdrawal-approval capability
 * against its Turnkey endpoints. Environment picks everything: sandbox uses
 * GROUND_SANDBOX_API_KEY / sandbox host / solana_devnet, production uses
 * GROUND_API_KEY / production host / solana. Per-strategy deposit/withdraw
 * quoting stays NOT_IMPLEMENTED from the stub base — Ground moves money at
 * the portfolio level, not per vault.
 */
export class GroundEarnClient
  extends StubEarnClient
  implements EarnPortfolioWalletProvider, EarnWithdrawalApprovalProvider
{
  readonly provider = "ground" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi", "rwa"],
    // Ground's depositToken enum is usdc|usdt only — no USDG — and USDT is
    // further excluded because Ground routes Solana rails as USDC-only
    // (GROUND_SOLANA_ROUTED_TOKENS): a USDT source never reaches SDP's
    // catalogue in any environment, so declaring it would only mask drift.
    depositTokens: ["USDC"],
  };

  /**
   * Page through the raw yield-source catalogue, unfiltered. Data source for
   * `listStrategies`, and the tooling surface the catalogue-inventory script
   * reads so it can report what distillation drops (underscore-prefixed like
   * RampClient._discoverProviderRails: a real consumer exists, but this is
   * not part of the provider contract).
   */
  async *_iterateYieldSources(ctx: EarnRuntimeContext): AsyncGenerator<GroundYieldSource, void> {
    const config = readGroundConfig(ctx);
    let cursor: string | null = null;
    do {
      const url = new URL("/v2/wallets/yield-sources", config.baseUrl);
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }
      const page: GroundListResponse<GroundYieldSource> = await providerFetchJson(
        this.provider,
        url.toString(),
        { method: "GET", headers: config.headers }
      );
      yield* page.data;
      cursor = page.nextCursor;
    } while (cursor);
  }

  override async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const snapshots: ProviderStrategySnapshot[] = [];
    for await (const source of this._iterateYieldSources(ctx)) {
      const distilled = distillGroundYieldSource(source, cluster);
      if (distilled.outcome === "catalogued") {
        snapshots.push(distilled.snapshot);
      }
    }
    return snapshots;
  }

  async createPortfolioWallet(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletCreateInput
  ): Promise<EarnPortfolioWalletCreateResult> {
    const config = readGroundConfig(ctx);
    const wallet = await providerFetchJson<
      GroundWallet,
      { requestId: string; label: string; strategy: { allocations: EarnPortfolioAllocationInput } }
    >(this.provider, `${config.baseUrl}/v2/wallets`, {
      method: "POST",
      headers: config.headers,
      body: {
        // No mint-when-absent fallback: a server-minted id is fresh per attempt,
        // so it guarantees the double-provision it appears to guard against. The
        // key is required by the input type (PRO-1670) precisely so this cannot
        // silently degrade.
        requestId: input.requestId,
        label: input.label,
        strategy: { allocations: input.allocations },
      },
    });
    return { providerWalletRef: wallet.id, status: normalizeWalletState(wallet.status).status };
  }

  async getPortfolioYield(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletRefInput
  ): Promise<EarnPortfolioYield> {
    const config = readGroundConfig(ctx);
    const result = await providerFetchJson<GroundWalletYield>(
      this.provider,
      `${config.baseUrl}/v2/wallets/${pathSegment(input.providerWalletRef, "wallet reference")}/yield`,
      { method: "GET", headers: config.headers }
    );
    const positions = (result.positions ?? []).map((position) => ({
      yieldSourceId: position.yieldSourceId,
      name: position.name,
      apy: bpsToDecimalString(position.apyBps ?? 0),
      pct: position.pct ?? 0,
      deployedValueUsd: position.deployedValueUsd,
    }));
    return {
      currentApy: blendPositionApy(positions),
      earnedUsd: result.earnedUsd,
      annualizedUsd: result.annualizedUsd ?? undefined,
      positions,
    };
  }

  async getPortfolioWallet(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletRefInput
  ): Promise<EarnPortfolioWalletSnapshot> {
    const config = readGroundConfig(ctx);
    const wallet = await providerFetchJson<GroundWallet>(
      this.provider,
      `${config.baseUrl}/v2/wallets/${pathSegment(input.providerWalletRef, "wallet reference")}`,
      { method: "GET", headers: config.headers }
    );
    return {
      providerWalletRef: wallet.id,
      ...normalizeWalletState(wallet.status),
      providerStatus: wallet.status,
      // Solana-only mandate: of Ground's multi-chain funding addresses, SDP
      // surfaces exactly the one on this environment's Solana rail.
      solanaDepositAddress: wallet.depositAddresses?.[config.chain],
      balance: {
        totalUsd: wallet.balance.totalUsd,
        withdrawableUsd: wallet.balance.withdrawableUsd,
        reservedUsd: wallet.balance.reservedUsd,
        earnedUsd: wallet.balance.earnedUsd,
      },
      positions: (wallet.positions ?? []).map(mapPosition),
      allocations: mapTargetAllocations(wallet.strategyAllocations),
    };
  }

  async updatePortfolioStrategy(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioStrategyUpdateInput
  ): Promise<EarnPortfolioStrategyUpdateResult> {
    const config = readGroundConfig(ctx);
    const result = await providerFetchJson<
      { strategyAllocations: GroundStrategyAllocations },
      { requestId: string; allocations: EarnPortfolioAllocationInput }
    >(
      this.provider,
      `${config.baseUrl}/v2/wallets/${pathSegment(input.providerWalletRef, "wallet reference")}/strategy`,
      {
        method: "PATCH",
        headers: config.headers,
        body: { requestId: input.requestId ?? crypto.randomUUID(), allocations: input.allocations },
      }
    );
    return { allocations: mapTargetAllocations(result.strategyAllocations) };
  }

  async listPortfolioDeposits(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioDepositsInput
  ): Promise<EarnPortfolioDepositsPage> {
    const config = readGroundConfig(ctx);
    const url = new URL(
      `/v2/wallets/${pathSegment(input.providerWalletRef, "wallet reference")}/deposits`,
      config.baseUrl
    );
    if (input.cursor) {
      url.searchParams.set("cursor", input.cursor);
    }
    const page: GroundListResponse<GroundDeposit> = await providerFetchJson(
      this.provider,
      url.toString(),
      { method: "GET", headers: config.headers }
    );
    return {
      deposits: page.data.map((deposit) => mapDeposit(deposit, config.chain)),
      nextCursor: page.nextCursor,
    };
  }

  async previewPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalPreviewInput
  ): Promise<EarnPortfolioWithdrawalPreview> {
    assertSolanaRoutable(input.token);
    const config = readGroundConfig(ctx);
    const preview = await providerFetchJson<
      GroundWithdrawalPreview,
      { destinationChain: string; token: string; amountUsd: number }
    >(
      this.provider,
      `${config.baseUrl}/v2/wallets/${pathSegment(input.providerWalletRef, "wallet reference")}/withdrawal-preview`,
      {
        method: "POST",
        headers: config.headers,
        body: {
          destinationChain: config.chain,
          token: input.token,
          amountUsd: parseUsdAmount(input.amountUsd),
        },
      }
    );
    return {
      amountRequestedUsd: preview.amountRequestedUsd ?? undefined,
      feeUsd: preview.feeUsd,
      withdrawableUsd: preview.withdrawableUsd,
      totalUsdAfterWithdrawal: preview.totalUsdAfterWithdrawal,
      processingEstimate: preview.processingEstimate ?? undefined,
    };
  }

  async createPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalCreateInput
  ): Promise<EarnPortfolioWithdrawal> {
    assertSolanaRoutable(input.token);
    const config = readGroundConfig(ctx);
    const withdrawal = await providerFetchJson<
      GroundWithdrawal,
      {
        requestId: string;
        destinationChain: string;
        token: string;
        amountUsd: number;
        destinationAddress: string;
      }
    >(
      this.provider,
      `${config.baseUrl}/v2/wallets/${pathSegment(input.providerWalletRef, "wallet reference")}/withdrawals`,
      {
        method: "POST",
        headers: config.headers,
        body: {
          // Caller-owned idempotency key: Ground replays the original response
          // for a matching payload and 409s (request_id_conflict) on a mismatch.
          requestId: input.requestId,
          destinationChain: config.chain,
          token: input.token,
          amountUsd: parseUsdAmount(input.amountUsd),
          destinationAddress: input.destinationAddress,
        },
      }
    );
    return mapWithdrawal(withdrawal);
  }

  async getPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalStatusInput
  ): Promise<EarnPortfolioWithdrawal> {
    const config = readGroundConfig(ctx);
    const withdrawal = await providerFetchJson<GroundWithdrawal>(
      this.provider,
      `${config.baseUrl}/v2/wallets/${pathSegment(input.providerWalletRef, "wallet reference")}/withdrawals/${pathSegment(input.withdrawalRef, "withdrawal reference")}`,
      { method: "GET", headers: config.headers }
    );
    return mapWithdrawal(withdrawal);
  }

  async createPortfolioAddressBookEntry(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioAddressBookEntryInput
  ): Promise<EarnPortfolioAddressBookEntryResult> {
    const config = readGroundConfig(ctx);
    const result = await providerFetchJson<
      { entry: string },
      { address: string; chain: string; label: string }
    >(this.provider, `${config.baseUrl}/v2/address-book/entries`, {
      method: "POST",
      headers: config.headers,
      body: { address: input.address, chain: config.chain, label: input.label },
    });
    return { entryRef: result.entry };
  }

  async listPendingWithdrawalApprovals(
    ctx: EarnRuntimeContext
  ): Promise<EarnPendingWithdrawalApproval[]> {
    const config = readGroundConfig(ctx);
    const result = await providerFetchJson<{ activities: GroundTurnkeyActivity[] }>(
      this.provider,
      `${config.baseUrl}/v2/turnkey/activities/pending`,
      { method: "GET", headers: config.headers }
    );
    return result.activities.map(mapTurnkeyActivity);
  }

  async createWithdrawalApprovalRequest(
    ctx: EarnRuntimeContext,
    input: EarnWithdrawalApprovalRequestInput
  ): Promise<EarnWithdrawalApprovalRequest> {
    const config = readGroundConfig(ctx);
    const result = await providerFetchJson<
      GroundTurnkeyApprovalRequest,
      { activityId: string; action: EarnWithdrawalApprovalAction }
    >(this.provider, `${config.baseUrl}/v2/turnkey/activity-approval-request`, {
      method: "POST",
      headers: config.headers,
      body: { activityId: input.approvalRef, action: input.action },
    });
    return {
      approvalRef: result.activityId,
      action: result.action,
      // stampPayload verbatim: the signer must stamp these exact bytes, so
      // this client never re-serializes turnkeyRequest into a payload itself.
      signingPayload: result.stampPayload,
      providerRequest: result.turnkeyRequest,
    };
  }

  async submitWithdrawalApprovalVote(
    ctx: EarnRuntimeContext,
    input: EarnWithdrawalApprovalVoteInput
  ): Promise<EarnWithdrawalApprovalVoteResult> {
    const config = readGroundConfig(ctx);
    const customerApprovalStamp =
      typeof input.stamp === "string"
        ? input.stamp
        : { stampHeaderName: input.stamp.headerName, stampHeaderValue: input.stamp.headerValue };
    const result = await providerFetchJson<
      GroundTurnkeyVoteResult,
      {
        action: EarnWithdrawalApprovalAction;
        customerApprovalStamp: typeof customerApprovalStamp;
        turnkeyRequest: Record<string, unknown>;
      }
    >(
      this.provider,
      `${config.baseUrl}/v2/turnkey/activities/${pathSegment(input.approvalRef, "approval reference")}/vote`,
      {
        method: "POST",
        headers: config.headers,
        body: {
          action: input.action,
          customerApprovalStamp,
          turnkeyRequest: input.providerRequest,
        },
      }
    );
    return {
      action: input.action,
      applied: input.action === "approve" ? result.approved === true : result.rejected === true,
      alreadyResolved: result.alreadyCompleted === true || result.alreadyTerminal === true,
      providerStatus: result.resultStatus ?? result.status ?? undefined,
    };
  }
}
