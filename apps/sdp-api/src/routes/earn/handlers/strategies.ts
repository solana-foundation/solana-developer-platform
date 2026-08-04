import type {
  EarnNavHistoryResponse,
  EarnNavPoint,
  EarnStrategy,
  EarnStrategyResponse,
  ListEarnStrategiesResponse,
} from "@sdp/types";
import type { EarnNavSnapshotRow, EarnStrategyRow } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository, resolveSdpEnvironment } from "../context";
import {
  earnNavHistoryQuerySchema,
  earnStrategyIdParamsSchema,
  listEarnStrategiesQuerySchema,
} from "../schemas";
import { listResponse, pageWindow, parseParams, parseQuery } from "./shared";

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

function mapToEarnNavPoint(row: EarnNavSnapshotRow): EarnNavPoint {
  return {
    strategyId: row.strategy_id,
    sharePrice: row.share_price,
    apy: row.apy ?? undefined,
    tvl: row.tvl ?? undefined,
    asOf: row.as_of,
  };
}

/**
 * Loads a strategy and hides it from callers in the other environment — the
 * catalogue is platform-global, so environment scoping happens here rather
 * than via project scoping.
 */
export async function requireEarnStrategy(
  c: AppContext,
  strategyId: string
): Promise<EarnStrategyRow> {
  const repo = getEarnRepository(c);
  const strategy = await repo.getStrategyById(strategyId);

  if (!strategy || strategy.environment !== resolveSdpEnvironment(c)) {
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

export const getEarnStrategyNavHistory = async (c: AppContext) => {
  const { strategyId } = parseParams(c, earnStrategyIdParamsSchema);
  const query = parseQuery(c, earnNavHistoryQuerySchema);

  const strategy = await requireEarnStrategy(c, strategyId);

  const repo = getEarnRepository(c);
  const snapshots = await repo.listNavSnapshots({
    strategyId: strategy.id,
    limit: query.limit,
  });

  const response: EarnNavHistoryResponse = {
    strategyId: strategy.id,
    navPoints: snapshots.map(mapToEarnNavPoint),
  };

  return success(c, response);
};
