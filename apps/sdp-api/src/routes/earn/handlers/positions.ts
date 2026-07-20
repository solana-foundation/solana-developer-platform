import type { EarnPosition, EarnPositionResponse, ListEarnPositionsResponse } from "@sdp/types";
import { z } from "zod";
import type { EarnPositionRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository } from "../context";
import { earnPositionIdParamsSchema, listEarnPositionsQuerySchema } from "../schemas";

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
  const parsed = listEarnPositionsQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, strategyId, includeClosed } = parsed.data;

  const repo = getEarnRepository(c);
  const { rows, total } = await repo.listPositions({
    organizationId: auth.organizationId,
    projectId,
    strategyId,
    includeClosed,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListEarnPositionsResponse = {
    positions: rows.map(mapToEarnPosition),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getEarnPosition = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = earnPositionIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getEarnRepository(c);
  const position = await repo.getPositionById({
    positionId: params.data.positionId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!position) {
    throw notFound("Earn position");
  }

  const response: EarnPositionResponse = { position: mapToEarnPosition(position) };
  return success(c, response);
};
