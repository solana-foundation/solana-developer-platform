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
  type EarnPortfolioWalletSnapshot,
  type EarnPortfolioWalletStatus,
  type EarnPortfolioWithdrawal,
  type EarnPortfolioWithdrawalPreview,
  type EarnPortfolioYield,
  type EarnStrategySourceKind,
  isWellKnownTokenSymbol,
  wellKnownMint,
} from "@sdp/types";
import { badRequest, providerNotConfigured } from "../../errors";
import { providerFetchJson } from "../../fetch";
import { bearerAuthHeader } from "../../shared";
import type {
  EarnDeclaredStrategySupport,
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
  ProviderStrategySnapshot,
} from "../../types";
import { StubEarnClient } from "../stub";

const GROUND_SANDBOX_API_URL = "https://sandbox.groundtech.co";
const GROUND_PRODUCTION_API_URL = "https://production.groundtech.co";

/** Solana rails per environment — the only chains SDP surfaces to Ground. */
const GROUND_SOLANA_CHAINS = { sandbox: "solana_devnet", production: "solana" } as const;

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

interface GroundYieldSourceAllocation {
  label: string;
  type?: string | null;
  valueUsd?: number | null;
  pct?: number | null;
}

interface GroundYieldSource {
  id: string;
  name: string;
  /** Documented: active | buy_only | sell_only | emergency_freeze — kept open. */
  mode: string;
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
  fromAddress?: string | null;
  txHash?: string | null;
  status?: string | null;
  createdAt: string;
  completedAt?: string | null;
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
 */
const RWA_ALLOCATION_TYPE = /treasur|t.?bill|clo|rwa|bond|credit|note/i;

/**
 * A Ground source is a basket of allocations; classify by the dominant side
 * (weighted by pct when reported, else counted) so a mostly-treasury source
 * reads as RWA even with a small DeFi reserve sleeve. Empty → defi.
 */
function classifySourceKind(
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
 */
function deriveCurator(source: GroundYieldSource): string | undefined {
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

const WALLET_STATUS_BY_GROUND_STATUS: Record<string, EarnPortfolioWalletStatus> = {
  creating: "creating",
  idle: "ready",
  withdrawal_active: "busy",
  rebalance_active: "busy",
  withdrawal_and_rebalance_active: "busy",
  failed: "failed",
};

/** Unknown statuses read as `busy`: funds stay visible, mutations wait. */
function normalizeWalletStatus(status: string): EarnPortfolioWalletStatus {
  return WALLET_STATUS_BY_GROUND_STATUS[status] ?? "busy";
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

function mapDeposit(deposit: GroundDeposit): EarnPortfolioDeposit {
  return {
    id: deposit.id,
    amountUsd: deposit.amount,
    // Ground only routes the tokens SDP declares, so an undeclared token here
    // is drift; surface it as usdc rather than dropping the funds from view.
    token: narrow(EARN_PORTFOLIO_TOKENS, deposit.token) ?? "usdc",
    status: narrow(EARN_PORTFOLIO_DEPOSIT_STATUSES, deposit.status) ?? "processing",
    fromAddress: deposit.fromAddress ?? undefined,
    transactionSignature: deposit.txHash ?? undefined,
    createdAt: deposit.createdAt,
    completedAt: deposit.completedAt ?? undefined,
  };
}

function mapWithdrawal(withdrawal: GroundWithdrawal): EarnPortfolioWithdrawal {
  return {
    withdrawalRef: withdrawal.id,
    status: narrow(EARN_PORTFOLIO_WITHDRAWAL_STATUSES, withdrawal.status) ?? "processing",
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
 * Ground's Portfolio Wallets API. Environment picks everything: sandbox uses
 * GROUND_SANDBOX_API_KEY / sandbox host / solana_devnet, production uses
 * GROUND_API_KEY / production host / solana. Per-strategy deposit/withdraw
 * quoting stays NOT_IMPLEMENTED from the stub base — Ground moves money at
 * the portfolio level, not per vault.
 */
export class GroundEarnClient extends StubEarnClient implements EarnPortfolioWalletProvider {
  readonly provider = "ground" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi", "rwa"],
    // Ground's depositToken enum is usdc|usdt only — no USDG.
    depositTokens: ["USDC", "USDT"],
  };

  override async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    const config = readGroundConfig(ctx);
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const snapshots: ProviderStrategySnapshot[] = [];

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

      for (const source of page.data) {
        // Only fully tradable sources enter the catalogue. buy_only would let
        // deposits into an exit-frozen source — trapped funds, which the Earn
        // pluggability constraint forbids; sell_only/emergency_freeze cannot
        // take deposits at all. Delisting is also how a paused source drains
        // from the depositable set (catalogue-sync re-asserts `active`).
        if (source.mode !== "active") {
          continue;
        }
        const symbol = source.depositToken.toUpperCase();
        if (!isWellKnownTokenSymbol(symbol)) {
          continue;
        }
        // No mint on this environment's cluster (USDT has no devnet mint) —
        // the strategy cannot be funded here, so keep it out of the catalogue.
        const mint = wellKnownMint(symbol, cluster);
        if (!mint) {
          continue;
        }

        const curator = deriveCurator(source);
        snapshots.push({
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
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

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
        requestId: input.requestId ?? crypto.randomUUID(),
        label: input.label,
        strategy: { allocations: input.allocations },
      },
    });
    return { providerWalletRef: wallet.id, status: normalizeWalletStatus(wallet.status) };
  }

  async getPortfolioYield(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletRefInput
  ): Promise<EarnPortfolioYield> {
    const config = readGroundConfig(ctx);
    const result = await providerFetchJson<GroundWalletYield>(
      this.provider,
      `${config.baseUrl}/v2/wallets/${input.providerWalletRef}/yield`,
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
      `${config.baseUrl}/v2/wallets/${input.providerWalletRef}`,
      { method: "GET", headers: config.headers }
    );
    return {
      providerWalletRef: wallet.id,
      status: normalizeWalletStatus(wallet.status),
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
    >(this.provider, `${config.baseUrl}/v2/wallets/${input.providerWalletRef}/strategy`, {
      method: "PATCH",
      headers: config.headers,
      body: { requestId: input.requestId ?? crypto.randomUUID(), allocations: input.allocations },
    });
    return { allocations: mapTargetAllocations(result.strategyAllocations) };
  }

  async listPortfolioDeposits(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioDepositsInput
  ): Promise<EarnPortfolioDepositsPage> {
    const config = readGroundConfig(ctx);
    const url = new URL(`/v2/wallets/${input.providerWalletRef}/deposits`, config.baseUrl);
    if (input.cursor) {
      url.searchParams.set("cursor", input.cursor);
    }
    const page: GroundListResponse<GroundDeposit> = await providerFetchJson(
      this.provider,
      url.toString(),
      { method: "GET", headers: config.headers }
    );
    return { deposits: page.data.map(mapDeposit), nextCursor: page.nextCursor };
  }

  async previewPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalPreviewInput
  ): Promise<EarnPortfolioWithdrawalPreview> {
    const config = readGroundConfig(ctx);
    const preview = await providerFetchJson<
      GroundWithdrawalPreview,
      { destinationChain: string; token: string; amountUsd: number }
    >(this.provider, `${config.baseUrl}/v2/wallets/${input.providerWalletRef}/withdrawal-preview`, {
      method: "POST",
      headers: config.headers,
      body: {
        destinationChain: config.chain,
        token: input.token,
        amountUsd: parseUsdAmount(input.amountUsd),
      },
    });
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
    >(this.provider, `${config.baseUrl}/v2/wallets/${input.providerWalletRef}/withdrawals`, {
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
    });
    return mapWithdrawal(withdrawal);
  }

  async getPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalStatusInput
  ): Promise<EarnPortfolioWithdrawal> {
    const config = readGroundConfig(ctx);
    const withdrawal = await providerFetchJson<GroundWithdrawal>(
      this.provider,
      `${config.baseUrl}/v2/wallets/${input.providerWalletRef}/withdrawals/${input.withdrawalRef}`,
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
}
