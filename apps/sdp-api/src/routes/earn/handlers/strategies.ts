import { isClusterFundableInEnvironment } from "@sdp/earn";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnProviderId,
  type EarnStrategy,
  type EarnStrategyResponse,
  earnDepositSlippageFloor,
  earnWithdrawSlippageFloor,
  isEarnProviderSurfaced,
  type ListEarnStrategiesResponse,
  type SdpEnvironment,
  SURFACED_EARN_PROVIDERS,
} from "@sdp/types";
import type { EarnStrategyRow } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository, resolveSdpEnvironment } from "../context";
import { earnStrategyIdParamsSchema, listEarnStrategiesQuerySchema } from "../schemas";
import { CURATED_VAULTS, HIDDEN_STRATEGY_TERMS, HIDDEN_VAULTS } from "./curation";
import { listResponse, pageWindow, parseParams, parseQuery } from "./shared";

/**
 * Rows absent from every public strategy read, for either of TWO independent
 * reasons — kept in one predicate so the detail route can never drift from the
 * list route's filters:
 *
 * 1. The row's PROVIDER is not currently offered (`EARN_PROVIDER_SURFACING` in
 *    @sdp/types). Platform-level: we are not selling that provider today.
 * 2. The row names a SOURCE we have decided not to show. Editorial, per-row.
 *
 * Both are visibility, and neither is entitlement or `fundable`. Note the
 * asymmetry with the money routes this deliberately does not reach: an existing
 * program may point at a row hidden by either rule, and `assertKnownYieldSources`
 * still accepts it from the stored catalogue precisely because hiding a
 * customer's own position would hide their money.
 */
export function isHiddenStrategy(row: EarnStrategyRow): boolean {
  if (!isEarnProviderSurfaced(row.provider)) {
    return true;
  }

  const hidden = HIDDEN_VAULTS[row.host_cluster] ?? [];
  if (hidden.includes(`${row.provider}:${row.provider_reference}` as never)) {
    return true;
  }

  const curated = CURATED_VAULTS[row.host_cluster]?.[row.provider as EarnProviderId];
  if (curated !== undefined && !curated.includes(row.provider_reference)) {
    return true;
  }

  const searchable = [row.provider_reference, row.name, row.underlying_source ?? ""]
    .join("\n")
    .toLowerCase();
  return HIDDEN_STRATEGY_TERMS.some((term) => searchable.includes(term));
}

/**
 * Takes the caller's environment because `fundable` is derived per request, not
 * stored: the catalogue is platform-global and the same row answers differently
 * to a sandbox and a production caller. A mainnet-only provider's row is listed
 * in both and fundable in one — see `hostCluster` in @sdp/types.
 */
export function mapToEarnStrategy(row: EarnStrategyRow, environment: SdpEnvironment): EarnStrategy {
  const depositSlippage = earnDepositSlippageFloor(row.provider);
  const withdrawalSlippage = earnWithdrawSlippageFloor(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    providerReference: row.provider_reference,
    name: row.name,
    sourceKind: row.source_kind,
    underlyingSource: row.underlying_source ?? undefined,
    depositMints: row.deposit_mints,
    shareMint: row.share_mint ?? undefined,
    apyType: row.apy_type,
    currentApy: row.current_apy ?? undefined,
    liquidityTerm: row.liquidity_term,
    redemptionDelayDays: row.redemption_delay_days ?? undefined,
    riskMetadata: row.risk_metadata,
    status: row.status,
    depositSlippage: depositSlippage
      ? { quoteRequired: true, defaultToleranceBps: depositSlippage.defaultToleranceBps }
      : null,
    withdrawalSlippage: withdrawalSlippage
      ? { quoteRequired: true, defaultToleranceBps: withdrawalSlippage.defaultToleranceBps }
      : null,
    hostCluster: row.host_cluster,
    fundable: isClusterFundableInEnvironment(row.host_cluster, environment),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Loads a strategy and applies the same environment and visibility policy as
 * the list route. The catalogue is platform-global, so environment scoping
 * happens here rather than via project scoping.
 */
export async function requireEarnStrategy(
  c: AppContext,
  strategyId: string
): Promise<EarnStrategyRow> {
  const repo = getEarnRepository(c);
  const strategy = await repo.getStrategyById(strategyId);

  if (
    !strategy ||
    strategy.environment !== resolveSdpEnvironment(c) ||
    isHiddenStrategy(strategy)
  ) {
    throw notFound("Earn strategy");
  }

  return strategy;
}

export const listEarnStrategies = async (c: AppContext) => {
  const query = parseQuery(c, listEarnStrategiesQuerySchema);

  const repo = getEarnRepository(c);
  const environment = resolveSdpEnvironment(c);
  // The shelf a caller can act on is the default; `?cluster=` is the explicit
  // opt-in that browses another cluster's sub-shelf — in practice a sandbox
  // reader reviewing the mirrored mainnet catalogue (PRO-1742). Opting in
  // changes what is LISTED, never what can take a deposit: a foreign-cluster
  // row still arrives `fundable: false` and every provider mutation re-asserts
  // the same predicate.
  const cluster = query.cluster ?? CLUSTER_BY_SDP_ENVIRONMENT[environment];
  const { rows, total } = await repo.listStrategies({
    environment,
    hostCluster: cluster,
    sourceKind: query.sourceKind,
    apyType: query.apyType,
    liquidityTerm: query.liquidityTerm,
    // Both visibility rules run in SQL so `total` and the page window describe
    // the rows the caller can see. `isHiddenStrategy` applies the same two rules
    // to the detail route, which has no query to push them into.
    providers: SURFACED_EARN_PROVIDERS,
    excludeProviderKeys: HIDDEN_VAULTS[cluster] ?? [],
    allowedProviderReferences: CURATED_VAULTS[cluster] ?? {},
    excludeRelatedTerms: HIDDEN_STRATEGY_TERMS,
    ...pageWindow(query),
  });

  const response: ListEarnStrategiesResponse = listResponse(query, total, {
    strategies: rows.map((row) => mapToEarnStrategy(row, environment)),
  });

  return success(c, response);
};

export const getEarnStrategy = async (c: AppContext) => {
  const { strategyId } = parseParams(c, earnStrategyIdParamsSchema);

  const strategy = await requireEarnStrategy(c, strategyId);

  const response: EarnStrategyResponse = {
    strategy: mapToEarnStrategy(strategy, resolveSdpEnvironment(c)),
  };
  return success(c, response);
};
