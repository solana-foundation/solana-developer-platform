import { z } from "zod";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
import { paginated, success } from "@/lib/response";
import { getAllowedApiKeyWalletAuthorizationForPermissions } from "@/services/api-key-scope.service";
import { normalizePaymentToken } from "@/services/payment-operation.service";
import { type AppContext, getPaymentTransferBatchesRepository } from "../../context";
import { listTransferBatchesQuerySchema, transferBatchIdParamsSchema } from "../../schemas";
import { assertPaymentWalletReadAccess } from "../../wallets";
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
  const walletAuthorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
    "payments:read",
  ]);
  if (query.data.sourceCustodyWalletId) {
    if (
      walletAuthorization &&
      !walletAuthorization.custodyWalletIds.includes(query.data.sourceCustodyWalletId)
    ) {
      throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
    }
  }
  const result = await getPaymentTransferBatchesRepository(c).listTransferBatches({
    organizationId: auth.organizationId,
    projectId,
    sourceCustodyWalletId: query.data.sourceCustodyWalletId,
    walletAuthorization:
      query.data.sourceCustodyWalletId || walletAuthorization === null
        ? undefined
        : walletAuthorization,
    token: query.data.token ? normalizePaymentToken(query.data.token, c.env) : undefined,
    status: query.data.status,
    externalId: query.data.externalId,
    limit: query.data.pageSize,
    offset: (query.data.page - 1) * query.data.pageSize,
  });
  result.rows.forEach((row) => {
    assertPaymentWalletReadAccess(c, {
      custodyWalletId: row.source_custody_wallet_id,
      providerWalletId: row.source_wallet_id,
    });
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

  assertPaymentWalletReadAccess(c, {
    custodyWalletId: batch.source_custody_wallet_id,
    providerWalletId: batch.source_wallet_id,
  });

  return success(c, await buildTransferBatchResponse(c, batch, auth.organizationId, projectId));
}
