import {
  FindReferenceError,
  findReference,
  ValidateTransferError,
  validateTransfer,
} from "@solana/pay";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
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

  const transfer = await createPaymentsRepository(env).createTransfer({
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

  const settled = await createPaymentRequestsRepository(env).markPaymentRequest({
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
  return row;
}
