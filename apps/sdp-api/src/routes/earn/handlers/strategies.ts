import type {
  EarnNavHistoryResponse,
  EarnNavPoint,
  EarnStrategy,
  EarnStrategyResponse,
  ListEarnStrategiesResponse,
} from "@sdp/types";
import { z } from "zod";
import type { EarnNavSnapshotRow, EarnStrategyRow } from "@/db/repositories";
import { badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository, resolveSdpEnvironment } from "../context";
import {
  earnNavHistoryQuerySchema,
  earnStrategyIdParamsSchema,
  listEarnStrategiesQuerySchema,
} from "../schemas";

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
  const parsed = listEarnStrategiesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, sourceKind, apyType, liquidityTerm } = parsed.data;

  const repo = getEarnRepository(c);
  const { rows, total } = await repo.listStrategies({
    environment: resolveSdpEnvironment(c),
    sourceKind,
    apyType,
    liquidityTerm,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListEarnStrategiesResponse = {
    strategies: rows.map(mapToEarnStrategy),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getEarnStrategy = async (c: AppContext) => {
  const params = earnStrategyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const strategy = await requireEarnStrategy(c, params.data.strategyId);

  const response: EarnStrategyResponse = { strategy: mapToEarnStrategy(strategy) };
  return success(c, response);
};

export const getEarnStrategyNavHistory = async (c: AppContext) => {
  const params = earnStrategyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const query = earnNavHistoryQuerySchema.safeParse(c.req.query());

  if (!query.success) {
    throw badRequestQuery({ errors: z.treeifyError(query.error) });
  }

  const strategy = await requireEarnStrategy(c, params.data.strategyId);

  const repo = getEarnRepository(c);
  const snapshots = await repo.listNavSnapshots({
    strategyId: strategy.id,
    limit: query.data.limit,
  });

  const response: EarnNavHistoryResponse = {
    strategyId: strategy.id,
    navPoints: snapshots.map(mapToEarnNavPoint),
  };

  return success(c, response);
};
