import type { EarnStrategy, EarnStrategyResponse, ListEarnStrategiesResponse } from "@sdp/types";
import type { EarnStrategyRow } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository, resolveSdpEnvironment } from "../context";
import { earnStrategyIdParamsSchema, listEarnStrategiesQuerySchema } from "../schemas";
import { listResponse, pageWindow, parseParams, parseQuery } from "./shared";

/**
 * Indexed for catalogue completeness, intentionally absent from every public
 * strategy read. Keep the terms here at the API policy boundary rather than in
 * Ground's client or the sync, so the DB continues to reflect what Ground
 * reports and pagination can exclude the rows before applying its window.
 */
const HIDDEN_STRATEGY_TERMS = ["aave", "morpho"] as const;

function isHiddenStrategy(row: EarnStrategyRow): boolean {
  const searchable = [row.provider_reference, row.name, row.underlying_source ?? ""]
    .join("\n")
    .toLowerCase();
  return HIDDEN_STRATEGY_TERMS.some((term) => searchable.includes(term));
}

export function mapToEarnStrategy(row: EarnStrategyRow): EarnStrategy {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Loads a strategy and applies the same environment and visibility policy as
 * the list route. The catalogue is platform-global, so environment scoping
 * happens here rather than via project scoping.
 */
async function requireEarnStrategy(c: AppContext, strategyId: string): Promise<EarnStrategyRow> {
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
  const { rows, total } = await repo.listStrategies({
    environment: resolveSdpEnvironment(c),
    sourceKind: query.sourceKind,
    apyType: query.apyType,
    liquidityTerm: query.liquidityTerm,
    excludeRelatedTerms: HIDDEN_STRATEGY_TERMS,
    ...pageWindow(query),
  });

  const response: ListEarnStrategiesResponse = listResponse(query, total, {
    strategies: rows.map(mapToEarnStrategy),
  });

  return success(c, response);
};

export const getEarnStrategy = async (c: AppContext) => {
  const { strategyId } = parseParams(c, earnStrategyIdParamsSchema);

  const strategy = await requireEarnStrategy(c, strategyId);

  const response: EarnStrategyResponse = { strategy: mapToEarnStrategy(strategy) };
  return success(c, response);
};
