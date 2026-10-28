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
import { badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { getAuthorized } from "@/middleware/authorize";
import type { ValidatedBodyContext } from "@/middleware/validate";
import type { AppContext } from "@/routes/payments/context";
import { resolveScope, resolveWallet } from "@/routes/payments/wallets";
import { normalizePaymentToken } from "@/services/payment-operation.service";
import { cancelOpenPaymentRequest } from "@/services/payments/payment-request-cancel";
import { isPaymentRequestExpired } from "@/services/payments/payment-requests";
import { parseStaticPaymentAmount } from "@/services/payments/token-amount";
import { type createPaymentRequestSchema, listPaymentRequestsQuerySchema } from "./schemas";

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
    canceledByApiKeyId: row.canceled_by_api_key_id,
    canceledByUserId: row.canceled_by_user_id,
    canceledAt: row.canceled_at,
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

export async function getPaymentRequest(c: AppContext) {
  return success(c, mapPaymentRequest(getAuthorized<PaymentRequestRow>(c)));
}

/**
 * The request's payment link token. Sharing the link is a manage-level act
 * (anyone holding it can build the request's fee-sponsored transaction), so
 * the route needs `payment_requests.manage`.
 */
export async function getPaymentRequestLink(c: AppContext) {
  const row = getAuthorized<PaymentRequestRow>(c);

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

/**
 * Cancel an open payment request: its `/pay` link stops building and sponsoring transactions.
 * An exit, so it takes `payment_requests.manage`. A request that is already canceled answers
 * with its row; a paid or expired one, or one whose sponsored transaction can still land, is a
 * 409. The response is the record a read returns, never the link token.
 *
 * A same-key retry after a 5xx reruns rather than replays (`serverErrors: "rerun"`): the cancel
 * is a compare-and-set on its own row, a canceled request answers 200, and a 5xx wrote nothing.
 *
 * @param c - The request context, after `authorizeExistingPaymentRequest` loaded the request.
 * @returns The canceled payment request.
 */
export async function cancelPaymentRequest(c: AppContext) {
  const row = await cancelOpenPaymentRequest(c, getAuthorized<PaymentRequestRow>(c));
  return success(c, mapPaymentRequest(row));
}
