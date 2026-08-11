import type { EarnMovement, EarnMovementResponse, ListEarnMovementsResponse } from "@sdp/types";
import type { EarnMovementRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getEarnRepository } from "../context";
import { earnMovementIdParamsSchema, listEarnMovementsQuerySchema } from "../schemas";
import { listResponse, pageWindow, parseParams, parseQuery } from "./shared";

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
  const query = parseQuery(c, listEarnMovementsQuerySchema);

  const repo = getEarnRepository(c);
  const { rows, total } = await repo.listMovements({
    organizationId: auth.organizationId,
    projectId,
    positionId: query.positionId,
    direction: query.direction,
    ...pageWindow(query),
  });

  const response: ListEarnMovementsResponse = listResponse(query, total, {
    movements: rows.map(mapToEarnMovement),
  });

  return success(c, response);
};

export const getEarnMovement = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const { movementId } = parseParams(c, earnMovementIdParamsSchema);

  const repo = getEarnRepository(c);
  const movement = await repo.getMovementById({
    movementId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!movement) {
    throw notFound("Earn movement");
  }

  const response: EarnMovementResponse = { movement: mapToEarnMovement(movement) };
  return success(c, response);
};
