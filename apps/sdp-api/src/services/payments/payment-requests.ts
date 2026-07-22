import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { toNumberAmount } from "@sdp/solana/amount";
import { SOL_MINT } from "@sdp/types";
import {
  FindReferenceError,
  findReference,
  ValidateTransferError,
  validateTransfer,
} from "@solana/pay";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import {
  createPaymentRequestsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { AppError, internalError, nullOnExpected } from "@/lib/errors";
import type { Env } from "@/types/env";

export function isPaymentRequestExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

/**
 * Checks the chain for a transaction referencing this payment request and,
 * when a valid payment is found, records the inbound transfer and marks the
 * request paid.
 *
 * @param env - API environment for RPC and database access.
 * @param row - The stored payment request row to reconcile.
 * @param options.bestEffort - When true, unexpected infra failures (e.g. an
 *   RPC outage) degrade to the stored row with a log so one bad row cannot
 *   take down a whole list read or the public pay page; the next read
 *   retries. Invariant violations (AppError) always rethrow — they do not
 *   self-heal and must not hide behind a stale row. When false, every
 *   failure rethrows, for paths that must not act on stale state.
 * @returns The settled row when a valid payment was found, otherwise the
 *   stored row.
 */
export async function reconcilePaymentRequest(
  env: Env,
  row: PaymentRequestRow,
  options: { bestEffort: boolean }
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment") {
    return row;
  }
  if (isPaymentRequestExpired(row.expires_at)) {
    return row;
  }

  try {
    return await settlePaymentRequestIfPaid(env, row);
  } catch (err) {
    if (!options.bestEffort || err instanceof AppError) {
      throw err;
    }
    console.error("reconcilePaymentRequest: best-effort reconcile failed, returning stored row", {
      paymentRequestId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return row;
  }
}

/**
 * Looks up the request's reference on chain, validates the referenced
 * transaction pays the right recipient/amount/mint, and settles the row to
 * `paid`.
 *
 * @returns The settled row, or the row unchanged when no valid payment
 *   exists yet.
 */
async function settlePaymentRequestIfPaid(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  const projectId = row.project_id;
  if (projectId === null) {
    throw internalError("payment_requests row is missing project_id");
  }

  const rpc = solanaRpc.createRpc(env);
  const reference = assertValidAddress(row.reference, "reference");

  const found = await nullOnExpected(
    findReference(rpc, reference, { commitment: "confirmed" }),
    FindReferenceError
  );
  if (found === null) {
    return row;
  }

  const validated = await nullOnExpected(
    validateTransfer(rpc, found.signature, {
      recipient: assertValidAddress(row.destination_address, "destinationAddress"),
      amount: toNumberAmount(row.amount),
      reference,
      ...(row.token === SOL_MINT ? {} : { splToken: assertValidAddress(row.token, "token") }),
    }),
    ValidateTransferError
  );
  if (validated === null) {
    return row;
  }

  const transfer = await recordInboundTransfer(env, row, projectId, found);

  const requestsRepo = createPaymentRequestsRepository(env);
  const settled = await requestsRepo.markPaymentRequest({
    requestId: row.id,
    organizationId: row.organization_id,
    projectId,
    status: "paid",
    fulfilledByTransferId: transfer.id,
    canceledBy: null,
  });
  if (settled) {
    return settled;
  }
  const current = await requestsRepo.getPaymentRequestById({
    requestId: row.id,
    organizationId: row.organization_id,
    projectId,
  });
  if (!current) {
    throw internalError("payment request not found after settlement");
  }
  return current;
}

/**
 * Records the inbound transfer that fulfilled a payment request.
 *
 * A concurrent reconcile of the same request inserts the same signature
 * (payment_transfers.signature is UNIQUE), so on a duplicate insert this
 * converges on the already-recorded row instead of bubbling the error.
 *
 * @param found - The on-chain transaction that paid the request.
 * @returns The recorded transfer row, whether inserted here or by a
 *   concurrent reconcile.
 */
async function recordInboundTransfer(
  env: Env,
  row: PaymentRequestRow,
  projectId: string,
  found: Awaited<ReturnType<typeof findReference>>
): Promise<PaymentTransferRow> {
  const paymentsRepo = createPaymentsRepository(env);
  try {
    const transfer = await paymentsRepo.createTransfer({
      organizationId: row.organization_id,
      projectId,
      walletId: row.wallet_id,
      counterpartyId: row.counterparty_id,
      sourceAddress: null,
      destinationAddress: row.destination_address,
      token: row.token,
      amount: row.amount,
      memo: null,
      type: "transfer",
      direction: "inbound",
      status: "confirmed",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: found.signature,
      slot: Number(found.slot),
      initiatedByKeyId: null,
    });
    if (!transfer) {
      throw internalError("Failed to record inbound transfer for payment request settlement");
    }
    return transfer;
  } catch (err) {
    if (!isPostgresUniqueViolation(err)) {
      throw err;
    }
    const recorded = await paymentsRepo.listTransfersBySignatures({
      signatures: [found.signature],
      organizationId: row.organization_id,
      projectId,
    });
    const existing = recorded[0];
    if (!existing) {
      throw err;
    }
    return existing;
  }
}
