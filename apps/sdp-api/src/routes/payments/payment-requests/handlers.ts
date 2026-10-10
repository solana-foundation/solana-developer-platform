import type { ListPaymentRequestsResponse, PaymentRequest } from "@sdp/types";
import { z } from "zod";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequest, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import {
  isPaymentRequestExpired,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { AppContext } from "../context";
import { assertFreshPaymentWalletAccess, resolveScope, resolveWallet } from "../wallets";
import { type createPaymentRequestSchema, listPaymentRequestsQuerySchema } from "./schemas";

function mapPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  const expired = isPaymentRequestExpired(row.expires_at);
  return {
    id: row.id,
    publicToken: row.public_token,
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    walletId: row.wallet_id,
    destinationAddress: row.destination_address,
    token: row.token,
    amount: row.amount,
    reference: row.reference,
    status: expired && row.status === "awaiting_payment" ? "expired" : row.status,
    expiresAt: row.expires_at,
    fulfilledByTransferId: row.fulfilled_by_transfer_id,
    canceledBy: row.canceled_by,
    lifecycle: row.lifecycle,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPaymentRequests(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const query = listPaymentRequestsQuerySchema.safeParse(c.req.query());
  if (!query.success) throw badRequestQuery();

  const { page, pageSize, status } = query.data;
  const { rows, total } = await createPaymentRequestsRepository(
    c.env,
    getRequestTenantScope(c)
  ).listPaymentRequests({
    organizationId: auth.organizationId,
    projectId,
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const reconciledRows = await Promise.all(
    rows.map((row) => reconcilePaymentRequest(c.env, row, { bestEffort: true }))
  );

  const response: ListPaymentRequestsResponse = {
    paymentRequests: reconciledRows.map(mapPaymentRequest),
    total,
    page,
    pageSize,
  };
  return success(c, response);
}

/** Resolves the receiving wallet and checks the caller's access to it, read fresh. */
async function resolveWritableWallet(c: AppContext, walletId: string) {
  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, walletId);
  assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, wallet, ["payments:write"]);
  return { scope, wallet };
}

const replayedWalletSchema = z.object({ walletId: z.string().min(1) });

/**
 * `authorizeReplay` for payment-request creation (HOO-1918): the caller must
 * still reach the receiving wallet, read fresh, before a stored response (which
 * carries the request's public token) is replayed. A body without `walletId`
 * was never stored, so it is refused rather than served unchecked.
 */
export async function authorizePaymentRequestReplay(c: AppContext): Promise<void> {
  const parsed = replayedWalletSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("walletId is required");
  }
  await resolveWritableWallet(c, parsed.data.walletId);
}

export async function createPaymentRequest(
  c: ValidatedBodyContext<typeof createPaymentRequestSchema>
) {
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const { scope, wallet } = await resolveWritableWallet(c, body.walletId);

  const row = await createPaymentRequestsRepository(
    c.env,
    getRequestTenantScope(c)
  ).createPaymentRequest({
    organizationId: scope.auth.organizationId,
    projectId,
    counterpartyId: body.counterpartyId,
    custodyWalletId: wallet.id,
    walletId: wallet.walletId,
    destinationAddress: wallet.publicKey,
    token: body.token,
    amount: body.amount,
    expiresAt: body.expiresAt,
    createdBy: await resolveCreatorUserId(c),
  });

  return created(c, mapPaymentRequest(row));
}
