import type { ListPaymentRequestsResponse, PaymentRequest } from "@sdp/types";
import type {
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { getAuth, requireProjectId } from "@/lib/auth";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
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
import {
  type createPaymentRequestSchema,
  listPaymentRequestsQuerySchema,
  paymentRequestIdParamsSchema,
} from "./schemas";

/**
 * How many of a project's newest open requests are checked on chain before a
 * status filter is applied. Each check is an RPC round trip, so the sweep is
 * capped rather than scaled with the number of open requests.
 */
export const PAYMENT_REQUESTS_RECONCILE_LIMIT = 100;

const PAYMENT_REQUESTS_RECONCILE_CONCURRENCY = 8;

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

/**
 * Settles the project's newest open requests that were paid on chain, so a
 * status filter that runs afterwards sees the real status instead of the
 * stored one.
 *
 * @returns The ids whose reconcile completed. A rejected reconcile is left
 *   out so the per-row page reconcile still runs for it and surfaces the
 *   error exactly as it does today.
 */
async function reconcileOpenPaymentRequests(
  c: AppContext,
  repo: PaymentRequestsRepository,
  params: { organizationId: string; projectId: string }
): Promise<Set<string>> {
  const openRows = await repo.listOpenPaymentRequests({
    ...params,
    limit: PAYMENT_REQUESTS_RECONCILE_LIMIT,
  });
  const settled = await mapSettledWithConcurrency(
    openRows,
    PAYMENT_REQUESTS_RECONCILE_CONCURRENCY,
    (row) => reconcilePaymentRequest(c.env, row, { bestEffort: true })
  );
  const reconciledIds = new Set<string>();
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      reconciledIds.add(openRows[index].id);
    }
  });
  return reconciledIds;
}

/**
 * Lists the project's payment requests, newest first.
 *
 * A request paid on chain keeps its stored `awaiting_payment` status until
 * something reads it, so filtering on the stored column would show paid rows
 * under "awaiting" and hide them from "paid". When the filter is
 * `awaiting_payment` or `paid`, the newest {@link PAYMENT_REQUESTS_RECONCILE_LIMIT}
 * open requests are checked on chain before the filter is applied; older open
 * requests keep their stored status until they are read. Rows the sweep
 * already checked are not reconciled a second time for the page.
 */
export async function listPaymentRequests(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const query = listPaymentRequestsQuerySchema.safeParse(c.req.query());
  if (!query.success) throw badRequestQuery();

  const { page, pageSize, status, search } = query.data;
  const repo = createPaymentRequestsRepository(c.env, getRequestTenantScope(c));

  const sweptIds =
    status === "awaiting_payment" || status === "paid"
      ? await reconcileOpenPaymentRequests(c, repo, {
          organizationId: auth.organizationId,
          projectId,
        })
      : new Set<string>();

  const { rows, total } = await repo.listPaymentRequests({
    organizationId: auth.organizationId,
    projectId,
    status,
    search,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const reconciledRows = await Promise.all(
    rows.map((row) =>
      sweptIds.has(row.id) ? row : reconcilePaymentRequest(c.env, row, { bestEffort: true })
    )
  );

  const response: ListPaymentRequestsResponse = {
    paymentRequests: reconciledRows.map(mapPaymentRequest),
    total,
    page,
    pageSize,
  };
  return success(c, response);
}

/**
 * Reads one payment request by id, reconciled against the chain the same way
 * the list is, so a request paid since its last read answers `paid`.
 */
export async function getPaymentRequest(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = paymentRequestIdParamsSchema.safeParse(c.req.param());
  if (!params.success) throw badRequestParams();

  const row = await createPaymentRequestsRepository(
    c.env,
    getRequestTenantScope(c)
  ).getPaymentRequestById({
    requestId: params.data.requestId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!row) throw notFound("Payment request");

  const reconciled = await reconcilePaymentRequest(c.env, row, { bestEffort: true });
  return success(c, mapPaymentRequest(reconciled));
}

export async function createPaymentRequest(
  c: ValidatedBodyContext<typeof createPaymentRequestSchema>
) {
  const projectId = requireProjectId(c);
  const body = c.req.valid("json");

  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, body.walletId);
  assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:write"]);
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
