import { getDb } from "@/db/client";
import type {
  CreatePaymentRequestInput,
  PaymentRequestRow,
} from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { createTenantScope } from "@/lib/tenant-scope";
import { required } from "@/test/helpers/required";
import type { Env } from "@/types/env";

/** The payment requests repository scoped to one Project, as a request in it sees it. */
function tenantRepository(env: Env, tenant: { organizationId: string; projectId: string }) {
  return createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: tenant.organizationId, projectId: tenant.projectId })
  );
}

/**
 * Create an open payment request through its Project's tenant-scoped repository, as the create
 * route stores one.
 *
 * @param env - Test bindings.
 * @param input - Every create field, the creating API key included.
 * @returns The stored request.
 */
export function seedPaymentRequest(
  env: Env,
  input: CreatePaymentRequestInput
): Promise<PaymentRequestRow> {
  return tenantRepository(env, input).createPaymentRequest(input);
}

/**
 * Cancel an open payment request through the repository's compare-and-set, as a request with
 * no sponsored claim is canceled.
 *
 * @param env - Test bindings.
 * @param request - The open request.
 * @param canceledBy - The principal recorded as canceling it.
 * @returns The canceled request.
 * @throws AssertionError when the request was not open.
 */
export async function cancelSeededPaymentRequest(
  env: Env,
  request: PaymentRequestRow,
  canceledBy: string
): Promise<PaymentRequestRow> {
  return required(
    await tenantRepository(env, {
      organizationId: request.organization_id,
      projectId: request.project_id,
    }).cancelPaymentRequest({
      requestId: request.id,
      organizationId: request.organization_id,
      projectId: request.project_id,
      canceledBy,
      liveClaimMinLastValidBlockHeight: null,
    })
  );
}

/**
 * Insert a confirmed inbound transfer into a request's receiving wallet for its token and amount,
 * the transfer a settlement links as the request's payment.
 *
 * @param env - Test bindings.
 * @param request - The request the transfer pays.
 * @returns The transfer id.
 */
export async function seedPaymentRequestTransfer(
  env: Env,
  request: PaymentRequestRow
): Promise<string> {
  const transferId = `xfr_${request.id}`;
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, custody_wallet_id, wallet_id, source_address,
         destination_address, token, amount, type, direction, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'PayerAddr', ?, ?, ?, 'transfer', 'inbound', 'confirmed',
                 '2026-06-23T00:00:00.000Z', '2026-06-23T00:00:00.000Z')`
    )
    .bind(
      transferId,
      request.organization_id,
      request.project_id,
      request.custody_wallet_id,
      request.wallet_id,
      request.destination_address,
      request.token,
      request.amount
    )
    .run();
  return transferId;
}

/**
 * Overwrite columns of one payment request, for states no repository method writes directly.
 *
 * @param env - Test bindings.
 * @param requestId - The request to update.
 * @param columns - Column names and the values to store.
 */
export async function setPaymentRequestColumns(
  env: Env,
  requestId: string,
  columns: Record<string, string | null>
): Promise<void> {
  const names = Object.keys(columns);
  await getDb(env)
    .prepare(
      `UPDATE payment_requests SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE id = ?`
    )
    .bind(...Object.values(columns), requestId)
    .run();
}
