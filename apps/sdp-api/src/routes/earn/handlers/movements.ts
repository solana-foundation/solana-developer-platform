import type { EarnMovement, EarnMovementResponse, ListEarnMovementsResponse } from "@sdp/types";
import { z } from "zod";
import type { EarnMovementRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository } from "../context";
import { earnMovementIdParamsSchema, listEarnMovementsQuerySchema } from "../schemas";

export function mapToEarnMovement(row: EarnMovementRow): EarnMovement {
  return {
    id: row.id,
    positionId: row.position_id,
    strategyId: row.strategy_id,
    direction: row.direction,
    tokenMint: row.token_mint,
    amount: row.amount,
    shareAmount: row.share_amount ?? undefined,
    status: row.status,
    transactionSignature: row.transaction_signature ?? undefined,
    redemptionAvailableAt: row.redemption_available_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const listEarnMovements = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listEarnMovementsQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, positionId, direction } = parsed.data;

  const repo = getEarnRepository(c);
  const { rows, total } = await repo.listMovements({
    organizationId: auth.organizationId,
    projectId,
    positionId,
    direction,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListEarnMovementsResponse = {
    movements: rows.map(mapToEarnMovement),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getEarnMovement = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = earnMovementIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getEarnRepository(c);
  const movement = await repo.getMovementById({
    movementId: params.data.movementId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!movement) {
    throw notFound("Earn movement");
  }

  const response: EarnMovementResponse = { movement: mapToEarnMovement(movement) };
  return success(c, response);
};
