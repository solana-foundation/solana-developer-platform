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
import {
  assertPaymentWalletExactAccess,
  resolveScope,
  resolveWallet,
} from "@/routes/payments/wallets";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { normalizePaymentToken } from "@/services/payment-operation.service";
import {
  isPaymentRequestExpired,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
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
  const row = await readPaymentRequest(c);
  const reconciled = await reconcilePaymentRequest(c.env, row, { bestEffort: true });
  return success(c, mapPaymentRequest(reconciled));
}

/**
 * The request's payment link token. Sharing the link is a manage-level act
 * (anyone holding it can build the request's fee-sponsored transaction), so
 * the route needs `payment_requests.manage`, and a wallet-bound key must hold
 * `payments:write` on the receiving wallet, as creation does.
 */
export async function getPaymentRequestLink(c: AppContext) {
  const auth = getAuth(c);
  const row = await readPaymentRequest(c);

  assertApiKeyWalletAccess(auth, row.wallet_id, ["payments:write"]);
  if (row.custody_wallet_id) {
    assertPaymentWalletExactAccess(c, row.custody_wallet_id, ["payments:write"]);
  }

  const response: PaymentRequestLink = { id: row.id, publicToken: row.public_token };
  return success(c, response);
}

export async function createPaymentRequest(
  c: ValidatedBodyContext<typeof createPaymentRequestSchema>
) {
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  // Access to the wallet and counterparty was checked by authorizePaymentRequest, before the
  // key. Whether the wallet is operational is state, checked here.
  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, body.walletId);

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
    token: normalizePaymentToken(body.token),
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
