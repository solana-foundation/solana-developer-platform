import type { EarnPosition, EarnPositionResponse, ListEarnPositionsResponse } from "@sdp/types";
import type { EarnPositionRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository } from "../context";
import { earnPositionIdParamsSchema, listEarnPositionsQuerySchema } from "../schemas";
import { listResponse, pageWindow, parseParams, parseQuery } from "./shared";

export function mapToEarnPosition(row: EarnPositionRow): EarnPosition {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    walletId: row.wallet_id,
    shareAmount: row.share_amount,
    costBasis: row.cost_basis ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const listEarnPositions = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const query = parseQuery(c, listEarnPositionsQuerySchema);

  const repo = getEarnRepository(c);
  const { rows, total } = await repo.listPositions({
    organizationId: auth.organizationId,
    projectId,
    strategyId: query.strategyId,
    includeClosed: query.includeClosed,
    ...pageWindow(query),
  });

  const response: ListEarnPositionsResponse = listResponse(query, total, {
    positions: rows.map(mapToEarnPosition),
  });

  return success(c, response);
};

export const getEarnPosition = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const { positionId } = parseParams(c, earnPositionIdParamsSchema);

  const repo = getEarnRepository(c);
  const position = await repo.getPositionById({
    positionId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!position) {
    throw notFound("Earn position");
  }

  const response: EarnPositionResponse = { position: mapToEarnPosition(position) };
  return success(c, response);
};
