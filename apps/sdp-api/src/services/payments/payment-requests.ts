import { createClusterRpc } from "@sdp/rpc/factory";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { verifyTransactionLanded } from "@sdp/rpc/verified-confirmation";
import { assertValidAddress } from "@sdp/solana/address";
import { toNumberAmount } from "@sdp/solana/amount";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Signature } from "@solana/kit";
import {
  FindReferenceError,
  findReference,
  ValidateTransferError,
  validateTransfer,
} from "@solana/pay";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "@/db/repositories/payment-requests.repository";
import {
  generatePaymentTransferId,
  type PaymentTransferRow,
} from "@/db/repositories/payments.repository";
import {
  createPaymentRequestsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { AppError, internalError, nullOnExpected } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import type { Env } from "@/types/env";

export function isPaymentRequestExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

type FoundPayment = Awaited<ReturnType<typeof findReference>>;

type SettlementTiming = "on_time" | "late" | "after_expired";

interface PaymentRequestKey {
  requestId: string;
  organizationId: string;
  projectId: string;
}

export async function reconcilePaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment" || isPaymentRequestExpired(row.expires_at)) {
    return row;
  }
  if (row.custody_wallet_id === null) {
    throw new AppError("CONFLICT", "Payment request wallet identity is unresolved");
  }
  return checkAwaitingPaymentRequest(env, row);
}

export async function checkAwaitingPaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (
    row.status !== "awaiting_payment" ||
    isPaymentRequestExpired(row.expires_at) ||
    row.custody_wallet_id === null
  ) {
    return row;
  }
  const found = await findValidPayment(createClusterRpc(), row);
  if (found === null) {
    return row;
  }
  return settlePaymentRequest(env, row, row.custody_wallet_id, found, "on_time");
}

export async function closeLapsedPaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment" || !isPaymentRequestExpired(row.expires_at)) {
    return row;
  }
  if (row.custody_wallet_id !== null) {
    const found = await findValidPayment(createClusterRpc(), row);
    if (found !== null) {
      const timing = landedAfterExpiry(found, row.expires_at) ? "late" : "on_time";
      return settlePaymentRequest(env, row, row.custody_wallet_id, found, timing);
    }
  }
  return markExpired(env, row);
}

export async function checkExpiredPaymentRequestForLatePayment(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (row.status !== "expired" || row.custody_wallet_id === null) {
    return row;
  }
  const found = await findValidPayment(createClusterRpc(), row);
  if (found === null) {
    return row;
  }
  return settlePaymentRequest(env, row, row.custody_wallet_id, found, "after_expired");
}

function landedAfterExpiry(found: FoundPayment, expiresAt: string | null): boolean {
  if (expiresAt === null) {
    return false;
  }
  if (found.blockTime === null) {
    return true;
  }
  return Number(found.blockTime) * 1000 > Date.parse(expiresAt);
}

async function findValidPayment(
  rpc: SolanaRpc,
  row: PaymentRequestRow
): Promise<FoundPayment | null> {
  const reference = assertValidAddress(row.reference, "reference");

  const found = await nullOnExpected(
    findReference(rpc, reference, { commitment: "confirmed" }),
    FindReferenceError
  );
  if (found === null) {
    return null;
  }

  const verified = await verifyTransactionLanded(rpc, found.signature as unknown as Signature);
  if (!verified.ok) {
    return null;
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
  return validated === null ? null : found;
}

async function settlePaymentRequest(
  env: Env,
  row: PaymentRequestRow,
  custodyWalletId: string,
  found: FoundPayment,
  timing: SettlementTiming
): Promise<PaymentRequestRow> {
  const key = paymentRequestKey(row);
  const transfer = await recordInboundTransfer(env, row, key.projectId, custodyWalletId, found);
  const requestsRepo = paymentRequestsRepositoryFor(env, key);

  const settled =
    timing === "after_expired"
      ? await requestsRepo.markExpiredPaymentRequestPaidLate({
          ...key,
          fulfilledByTransferId: transfer.id,
        })
      : await requestsRepo.markPaymentRequest({
          ...key,
          status: "paid",
          fulfilledByTransferId: transfer.id,
          canceledBy: null,
          paidLate: timing === "late",
        });
  return settled ?? (await reread(requestsRepo, key));
}

async function markExpired(env: Env, row: PaymentRequestRow): Promise<PaymentRequestRow> {
  const key = paymentRequestKey(row);
  const requestsRepo = paymentRequestsRepositoryFor(env, key);
  const expired = await requestsRepo.markPaymentRequest({
    ...key,
    status: "expired",
    fulfilledByTransferId: null,
    canceledBy: null,
  });
  return expired ?? (await reread(requestsRepo, key));
}

async function reread(
  requestsRepo: PaymentRequestsRepository,
  key: PaymentRequestKey
): Promise<PaymentRequestRow> {
  const current = await requestsRepo.getPaymentRequestById(key);
  if (!current) {
    throw internalError("payment request not found after settlement");
  }
  return current;
}

function paymentRequestsRepositoryFor(env: Env, key: PaymentRequestKey): PaymentRequestsRepository {
  return createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: key.organizationId, projectId: key.projectId })
  );
}

function paymentRequestKey(row: PaymentRequestRow): PaymentRequestKey {
  const projectId = row.project_id;
  // TODO: once migration 0129 makes payment_requests.project_id NOT NULL (HOO-1966), narrow PaymentRequestRow.project_id to string and delete this guard.
  if (projectId === null) {
    throw internalError("payment_requests row is missing project_id");
  }
  return { requestId: row.id, organizationId: row.organization_id, projectId };
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
  custodyWalletId: string,
  found: Awaited<ReturnType<typeof findReference>>
): Promise<PaymentTransferRow> {
  const paymentsRepo = createPaymentsRepository(
    env,
    createTenantScope({
      organizationId: row.organization_id,
      projectId,
    })
  );
  try {
    const transfer = await paymentsRepo.createTransfer({
      id: generatePaymentTransferId(),
      organizationId: row.organization_id,
      projectId,
      custodyWalletId,
      walletId: row.wallet_id,
      counterpartyId: null,
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
    if (
      existing.custody_wallet_id !== row.custody_wallet_id ||
      existing.wallet_id !== row.wallet_id ||
      existing.destination_address !== row.destination_address ||
      existing.token !== row.token ||
      existing.amount !== row.amount ||
      existing.type !== "transfer" ||
      existing.direction !== "inbound"
    ) {
      throw new AppError("CONFLICT", "Recorded transfer does not match payment request");
    }
    return existing;
  }
}
