import type { ListPaymentRequestsResponse, PaymentRequest } from "@sdp/types";
import { z } from "zod";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequest, badRequestQuery } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { isAddress } from "@/lib/solana";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import type { AppContext } from "../context";
import { paymentAmountSchema } from "../schemas";
import { resolveScope, resolveWallet } from "../wallets";

const listPaymentRequestsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["awaiting_payment", "paid", "canceled", "expired"]).optional(),
});

function mapPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  const expired = row.expires_at !== null && Date.parse(row.expires_at) <= Date.now();
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
  const { rows, total } = await createPaymentRequestsRepository(c.env).listPaymentRequests({
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

const createPaymentRequestSchema = z.object({
  walletId: z.string().min(1),
  token: z.string().refine(isAddress, "token must be a valid Solana mint address"),
  amount: paymentAmountSchema,
  // Optional counterparty (the payer). When set, payment is expected from this
  // counterparty's crypto account; when null the link is payable by anyone.
  counterpartyId: z.string().min(1).nullable().default(null),
  // Absolute UTC expiry (ISO 8601). The client converts the user's local
  // selection to UTC before sending; the server stores UTC verbatim.
  expiresAt: z.string().datetime().nullable().default(null),
});

export async function createPaymentRequest(c: AppContext) {
  const projectId = requireProjectId(c);
  const body = createPaymentRequestSchema.safeParse(await c.req.json());
  if (!body.success) {
    throw badRequest("Invalid payment request");
  }

  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, body.data.walletId);
  assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:write"]);

  const row = await createPaymentRequestsRepository(c.env).createPaymentRequest({
    organizationId: scope.auth.organizationId,
    projectId,
    counterpartyId: body.data.counterpartyId,
    walletId: wallet.walletId,
    destinationAddress: wallet.publicKey,
    token: body.data.token,
    amount: body.data.amount,
    expiresAt: body.data.expiresAt,
    createdBy: await resolveCreatorUserId(c),
  });

  return created(c, mapPaymentRequest(row));
}
