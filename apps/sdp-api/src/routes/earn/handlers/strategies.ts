import { isClusterFundableInEnvironment } from "@sdp/earn";
import type {
  EarnStrategy,
  EarnStrategyResponse,
  ListEarnStrategiesResponse,
  SdpEnvironment,
} from "@sdp/types";
import type { EarnStrategyRow } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository, resolveSdpEnvironment } from "../context";
import { earnStrategyIdParamsSchema, listEarnStrategiesQuerySchema } from "../schemas";
import { listResponse, pageWindow, parseParams, parseQuery } from "./shared";

/**
 * Takes the caller's environment because `fundable` is derived per request, not
 * stored: the catalogue is platform-global and the same row answers differently
 * to a sandbox and a production caller. A mainnet-only provider's row is listed
 * in both and fundable in one — see `hostCluster` in @sdp/types.
 */
export function mapToEarnStrategy(row: EarnStrategyRow, environment: SdpEnvironment): EarnStrategy {
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
    hostCluster: row.host_cluster,
    fundable: isClusterFundableInEnvironment(row.host_cluster, environment),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Loads a strategy and hides it from callers in the other environment — the
 * catalogue is platform-global, so environment scoping happens here rather
 * than via project scoping.
 */
async function requireEarnStrategy(c: AppContext, strategyId: string): Promise<EarnStrategyRow> {
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
  const environment = resolveSdpEnvironment(c);
  const { rows, total } = await repo.listStrategies({
    environment,
    sourceKind: query.sourceKind,
    apyType: query.apyType,
    liquidityTerm: query.liquidityTerm,
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
