import { assertValidAddress } from "@sdp/solana/address";
import type {
  CreatedPaymentRequest,
  ListPaymentRequestsResponse,
  PaymentRequest,
  PaymentRequestLink,
} from "@sdp/types/payments";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import type { AppContext } from "@/routes/payments/context";
import { resolveScope, resolveWallet } from "@/routes/payments/wallets";
import { normalizePaymentToken } from "@/services/payment-operation.service";
import { isPaymentRequestExpired } from "@/services/payments/payment-requests";
import { parseStaticPaymentAmount } from "@/services/payments/token-amount";
import {
  type createPaymentRequestSchema,
  listPaymentRequestsQuerySchema,
  paymentRequestParamsSchema,
} from "./schemas";

/**
 * A payment request without its public token. The token is the bearer
 * credential behind `/pay/:token`, so reads never disclose it (APE-849): only
 * the create response and the `payment_requests.manage` link read return it.
 */
function mapPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  const expired = isPaymentRequestExpired(row.expires_at);
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    walletId: row.wallet_id,
    destinationAddress: row.destination_address,
    token: row.token,
    amount: row.amount,
    reference: row.reference,
    status: expired && row.status === "awaiting_payment" ? "expired" : row.status,
    expiresAt: row.expires_at,
    fulfilledByTransferId: row.fulfilled_by_transfer_id,
    paidLate: row.paid_late,
    lastCheckedAt: row.last_verified_at,
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

  const response: ListPaymentRequestsResponse = {
    paymentRequests: rows.map(mapPaymentRequest),
    total,
    page,
    pageSize,
  };
  return success(c, response);
}

async function readPaymentRequest(c: AppContext): Promise<PaymentRequestRow> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = paymentRequestParamsSchema.safeParse(c.req.param());
  if (!params.success) throw badRequestParams();

  const row = await createPaymentRequestsRepository(
    c.env,
    getRequestTenantScope(c)
  ).getPaymentRequestById({
    requestId: params.data.paymentRequestId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!row) throw notFound("Payment request");
  return row;
}

export async function getPaymentRequest(c: AppContext) {
  return success(c, mapPaymentRequest(await readPaymentRequest(c)));
}

/**
 * The request's payment link token. Sharing the link is a manage-level act
 * (anyone holding it can build the request's fee-sponsored transaction), so
 * the route needs `payment_requests.manage`.
 */
export async function getPaymentRequestLink(c: AppContext) {
  const row = await readPaymentRequest(c);

  const response: PaymentRequestLink = { id: row.id, publicToken: row.public_token };
  return success(c, response);
}

export async function createPaymentRequest(
  c: ValidatedBodyContext<typeof createPaymentRequestSchema>
) {
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  // Access to the wallet was checked by authorizePaymentRequest, before the key. Whether the
  // wallet is operational is state, checked here.
  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, body.walletId);
  const token = assertValidAddress(normalizePaymentToken(body.token), "token");
  await parseStaticPaymentAmount(body.amount, token);

  const row = await createPaymentRequestsRepository(
    c.env,
    getRequestTenantScope(c)
  ).createPaymentRequest({
    organizationId: scope.auth.organizationId,
    projectId,
    custodyWalletId: wallet.id,
    walletId: wallet.walletId,
    destinationAddress: wallet.publicKey,
    token,
    amount: body.amount,
    expiresAt: body.expiresAt,
    createdBy: await resolveCreatorUserId(c),
  });

  const response: CreatedPaymentRequest = {
    ...mapPaymentRequest(row),
    publicToken: row.public_token,
  };
  return created(c, response);
}
