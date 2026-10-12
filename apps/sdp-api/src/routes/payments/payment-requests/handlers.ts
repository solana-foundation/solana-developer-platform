import type { ListPaymentRequestsResponse, PaymentRequest } from "@sdp/types";
import { getDb } from "@/db";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequestQuery, conflict, walletNotFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  isPaymentRequestExpired,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { AppContext } from "../context";
import {
  assertFreshPaymentWalletAccess,
  assertPaymentWalletExactAccess,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "../wallets";
import { type createPaymentRequestSchema, listPaymentRequestsQuerySchema } from "./schemas";

async function resolveLegacyPaymentRequestWallet(
  c: AppContext,
  scope: ResolvedScope,
  walletId: string
) {
  const projectId = requireProjectId(c);
  // Retained aliases count; creation eligibility is checked on the proven exact ID.
  const candidates = await getDb(c.env)
    .prepare(
      `SELECT w.id FROM custody_wallets w
       LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
       LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
       WHERE w.wallet_id = ?
         AND ((cfg.organization_id = ? AND cfg.project_id = ?)
           OR (conn.organization_id = ? AND conn.project_id = ?))
       LIMIT 2`
    )
    .bind(walletId, scope.auth.organizationId, projectId, scope.auth.organizationId, projectId)
    .all<{ id: string }>();
  if (candidates.results.length > 1) throw conflict("Custody wallet ownership is ambiguous");
  const candidate = candidates.results[0];
  if (!candidate) throw walletNotFound();
  return resolveWalletByCustodyWalletId(scope.wallets, candidate.id);
}

function mapPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  const expired = isPaymentRequestExpired(row.expires_at);
  return {
    id: row.id,
    publicToken: row.public_token,
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    custodyWalletId: row.custody_wallet_id,
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

export async function createPaymentRequest(
  c: ValidatedBodyContext<typeof createPaymentRequestSchema>
) {
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const scope = await resolveScope(c);
  const wallet =
    body.custodyWalletId !== undefined
      ? resolveWalletByCustodyWalletId(scope.wallets, body.custodyWalletId)
      : await resolveLegacyPaymentRequestWallet(c, scope, body.walletId);
  assertPaymentWalletExactAccess(c, wallet.id, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, wallet, ["payments:write"]);

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
