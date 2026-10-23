import { z } from "zod";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
import { paginated, success } from "@/lib/response";
import {
  type AppContext,
  getPaymentTransferBatchesRepository,
  getTokenMovementLegsRepository,
} from "@/routes/payments/context";
import { normalizePaymentToken } from "@/services/payment-operation.service";
import { buildTransferBatchResponse, mapBatchRow } from "./respond";
import { listTransferBatchesQuerySchema, transferBatchIdParamsSchema } from "./schemas";

/**
 * GET /transfer-batches — paginated batch listing scoped to the project.
 *
 * @param c - Request context.
 * @returns Paginated JSON response of batches.
 */
export async function listTransferBatches(c: AppContext) {
  const query = listTransferBatchesQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    throw badRequestQuery({
      errors: z.flattenError(query.error).fieldErrors,
    });
  }

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const result = await getPaymentTransferBatchesRepository(c).listTransferBatches({
    organizationId: auth.organizationId,
    projectId,
    sourceCustodyWalletId: query.data.sourceCustodyWalletId,
    token: query.data.token ? normalizePaymentToken(query.data.token) : undefined,
    status: query.data.status,
    externalId: query.data.externalId,
    limit: query.data.pageSize,
    offset: (query.data.page - 1) * query.data.pageSize,
  });

  const totals = await getTokenMovementLegsRepository(c).sumLegsByBatches(
    result.rows.map((row) => row.id)
  );
  return paginated(
    c,
    // A batch written before quotes has no legs (legacy = no leg).
    result.rows.map((row) => mapBatchRow(row, totals.get(row.id) ?? null)),
    {
      total: result.total,
      page: query.data.page,
      pageSize: query.data.pageSize,
    }
  );
}

/**
 * GET /transfer-batches/:batchId — a single batch with its recipients and
 * chunk transfers.
 *
 * @param c - Request context.
 * @returns JSON batch response.
 */
export async function getTransferBatch(c: AppContext) {
  const params = transferBatchIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({
      errors: z.flattenError(params.error).fieldErrors,
    });
  }

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const batchRepository = getPaymentTransferBatchesRepository(c);
  const batch = await batchRepository.getTransferBatchById({
    batchId: params.data.batchId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!batch) {
    throw notFound("Transfer batch");
  }

  return success(c, await buildTransferBatchResponse(c, batch, auth.organizationId, projectId));
}
