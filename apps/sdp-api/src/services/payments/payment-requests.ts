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
import { internalError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { SOL_MINT } from "@/services/payment-operation.service";
import * as solanaRpc from "@/services/solana/rpc";
import type { Env } from "@/types/env";

export function isPaymentRequestExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

export async function reconcilePaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment") {
    return row;
  }
  if (isPaymentRequestExpired(row.expires_at)) {
    return row;
  }

  const projectId = row.project_id;
  if (projectId === null) {
    throw internalError("payment_requests row is missing project_id");
  }

  const rpc = solanaRpc.createRpc(env);
  const reference = assertValidAddress(row.reference, "reference");

  let found: Awaited<ReturnType<typeof findReference>>;
  try {
    found = await findReference(rpc, reference, { commitment: "confirmed" });
  } catch (err) {
    if (err instanceof FindReferenceError) {
      return row;
    }
    throw err;
  }

  try {
    await validateTransfer(rpc, found.signature, {
      recipient: assertValidAddress(row.destination_address, "destinationAddress"),
      amount: Number(row.amount),
      reference,
      ...(row.token === SOL_MINT ? {} : { splToken: assertValidAddress(row.token, "token") }),
    });
  } catch (err) {
    if (err instanceof ValidateTransferError) {
      return row;
    }
    throw err;
  }

  const paymentsRepo = createPaymentsRepository(env);
  let transfer: PaymentTransferRow | null;
  try {
    transfer = await paymentsRepo.createTransfer({
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
  } catch (err) {
    // A concurrent reconcile of the same request inserts the same signature
    // (payment_transfers.signature is UNIQUE); converge on its row instead of
    // bubbling the duplicate-insert error.
    if (!isPostgresUniqueViolation(err)) {
      throw err;
    }
    const recorded = await paymentsRepo.listTransfersBySignatures({
      signatures: [found.signature],
      organizationId: row.organization_id,
      projectId,
    });
    if (recorded.length === 0) {
      throw err;
    }
    transfer = recorded[0];
  }
  if (!transfer) {
    throw internalError("Failed to record inbound transfer for payment request settlement");
  }

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

// Read-path wrapper: a transient RPC failure while reconciling one row must not
// take down a whole list (Promise.all) or the public pay page. Degrade to the
// stored row and log; the next read retries.
export async function reconcilePaymentRequestBestEffort(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  try {
    return await reconcilePaymentRequest(env, row);
  } catch (err) {
    console.error("reconcilePaymentRequestBestEffort: reconcile failed, returning stored row", {
      paymentRequestId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return row;
  }
}
