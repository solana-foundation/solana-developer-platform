import { z } from "zod";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequestParams, badRequestQuery, forbidden, notFound } from "@/lib/errors";
import { paginated, success } from "@/lib/response";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIds,
} from "@/services/api-key-scope.service";
import { normalizePaymentToken } from "@/services/payment-operation.service";
import { type AppContext, getPaymentTransferBatchesRepository } from "../../context";
import { listTransferBatchesQuerySchema, transferBatchIdParamsSchema } from "../../schemas";
import { buildTransferBatchResponse, mapBatchRow } from "./respond";

/**
 * GET /transfer-batches — paginated batch listing scoped to the project and
 * the API key's allowed wallets.
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
  if (query.data.wallet) {
    assertApiKeyWalletAccess(auth, query.data.wallet, ["payments:read"]);
  }
  const allowedWalletIds = getAllowedApiKeyWalletIds(auth);
  const result = await getPaymentTransferBatchesRepository(c).listTransferBatches({
    organizationId: auth.organizationId,
    projectId,
    walletId: query.data.wallet,
    walletIds: query.data.wallet ? undefined : (allowedWalletIds ?? undefined),
    token: query.data.token ? normalizePaymentToken(query.data.token, c.env) : undefined,
    status: query.data.status,
    externalId: query.data.externalId,
    limit: query.data.pageSize,
    offset: (query.data.page - 1) * query.data.pageSize,
  });

  return paginated(
    c,
    result.rows.map((row) => mapBatchRow(row)),
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

  const allowedWalletIds = getAllowedApiKeyWalletIds(auth);
  if (allowedWalletIds && !allowedWalletIds.includes(batch.source_wallet_id)) {
    throw forbidden("API key is not authorized for the requested wallet");
  }

  return success(c, await buildTransferBatchResponse(c, batch, auth.organizationId, projectId));
}
