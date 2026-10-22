import { createClusterRpc } from "@sdp/rpc/factory";
import { getSignaturesForAddress, type SolanaRpc } from "@sdp/rpc/solana";
import { verifyTransactionLanded } from "@sdp/rpc/verified-confirmation";
import { assertValidAddress } from "@sdp/solana/address";
import { toNumberAmount } from "@sdp/solana/amount";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Signature } from "@solana/kit";
import { ValidateTransferError, validateTransfer } from "@solana/pay";
import { asTransactionalClient, getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "@/db/repositories/payment-requests.repository";
import {
  generatePaymentTransferId,
  type PaymentsRepository,
  type PaymentTransferRow,
} from "@/db/repositories/payments.repository";
import {
  createPaymentRequestsRepository,
  createTransactionalPaymentRequestsRepository,
  createTransactionalPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { AppError, internalError, nullOnExpected } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import type { Env } from "@/types/env";

const REFERENCE_SIGNATURE_LIMIT = 100;
const MAX_PAYMENT_CANDIDATES = 10;

export function isPaymentRequestExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

interface FoundPayment {
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
}

type PaymentSearchResult =
  | { kind: "paid"; found: FoundPayment }
  | { kind: "pending" }
  | { kind: "none" };

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
  const result = await findValidPayment(createClusterRpc(), row);
  if (result.kind !== "paid") {
    return row;
  }
  return settlePaymentRequest(env, row, row.custody_wallet_id, result.found);
}

export async function closeLapsedPaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment" || !isPaymentRequestExpired(row.expires_at)) {
    return row;
  }
  if (row.custody_wallet_id !== null) {
    const result = await findValidPayment(createClusterRpc(), row);
    if (result.kind === "paid") {
      return settlePaymentRequest(env, row, row.custody_wallet_id, result.found);
    }
    if (result.kind === "pending") {
      return row;
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
  const result = await findValidPayment(createClusterRpc(), row);
  if (result.kind !== "paid") {
    return row;
  }
  return settlePaymentRequest(env, row, row.custody_wallet_id, result.found);
}

function isPaidLate(blockTime: bigint | null, expiresAt: string | null): boolean {
  if (expiresAt === null) {
    return false;
  }
  return blockTime !== null
    ? Number(blockTime) * 1000 > Date.parse(expiresAt)
    : isPaymentRequestExpired(expiresAt);
}

async function findValidPayment(
  rpc: SolanaRpc,
  row: PaymentRequestRow
): Promise<PaymentSearchResult> {
  const reference = assertValidAddress(row.reference, "reference");
  const signatures = await getSignaturesForAddress(rpc, reference, {
    commitment: "confirmed",
    limit: REFERENCE_SIGNATURE_LIMIT,
  });
  const candidates = signatures
    .filter((info) => info.err === null)
    .reverse()
    .slice(0, MAX_PAYMENT_CANDIDATES);

  let pending = false;
  for (const candidate of candidates) {
    const verified = await verifyTransactionLanded(rpc, candidate.signature);
    if (!verified.ok) {
      pending ||= verified.reason === "not_indexed";
      continue;
    }
    const validated = await nullOnExpected(
      validateTransfer(rpc, candidate.signature, {
        recipient: assertValidAddress(row.destination_address, "destinationAddress"),
        amount: toNumberAmount(row.amount),
        reference,
        ...(row.token === SOL_MINT ? {} : { splToken: assertValidAddress(row.token, "token") }),
      }),
      ValidateTransferError
    );
    if (validated !== null) {
      return {
        kind: "paid",
        found: {
          signature: candidate.signature,
          slot: candidate.slot,
          blockTime: candidate.blockTime ?? verified.transaction.blockTime ?? null,
        },
      };
    }
  }
  return pending ? { kind: "pending" } : { kind: "none" };
}

async function settlePaymentRequest(
  env: Env,
  row: PaymentRequestRow,
  custodyWalletId: string,
  found: FoundPayment
): Promise<PaymentRequestRow> {
  const key = paymentRequestKey(row);
  const scope = createTenantScope({ organizationId: key.organizationId, projectId: key.projectId });
  const paidLate = isPaidLate(found.blockTime, row.expires_at);
  const settle = () =>
    getDb(env).transaction(async (tx) => {
      const db = asTransactionalClient(tx);
      const transfer = await recordInboundTransfer(
        createTransactionalPaymentsRepository(db, scope),
        row,
        key.projectId,
        custodyWalletId,
        found
      );
      return transitionToPaid(
        createTransactionalPaymentRequestsRepository(db, scope),
        row,
        key,
        transfer.id,
        paidLate
      );
    });
  try {
    return await settle();
  } catch (err) {
    if (!isPostgresUniqueViolation(err)) {
      throw err;
    }
    return settle();
  }
}

async function transitionToPaid(
  requestsRepo: PaymentRequestsRepository,
  row: PaymentRequestRow,
  key: PaymentRequestKey,
  transferId: string,
  paidLate: boolean
): Promise<PaymentRequestRow> {
  const paid = { ...key, fulfilledByTransferId: transferId, paidLate };
  if (row.status === "awaiting_payment") {
    const settled = await requestsRepo.markPaymentRequest({
      ...paid,
      status: "paid",
      canceledBy: null,
    });
    if (settled) {
      return settled;
    }
  }
  const current = await reread(requestsRepo, key);
  if (current.status !== "expired") {
    return current;
  }
  return (
    (await requestsRepo.markExpiredPaymentRequestPaid(paid)) ?? (await reread(requestsRepo, key))
  );
}

async function markExpired(env: Env, row: PaymentRequestRow): Promise<PaymentRequestRow> {
  const key = paymentRequestKey(row);
  const requestsRepo = createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: key.organizationId, projectId: key.projectId })
  );
  const expired = await requestsRepo.markPaymentRequest({
    ...key,
    status: "expired",
    fulfilledByTransferId: null,
    canceledBy: null,
    paidLate: false,
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

function paymentRequestKey(row: PaymentRequestRow): PaymentRequestKey {
  return { requestId: row.id, organizationId: row.organization_id, projectId: row.project_id };
}

async function recordInboundTransfer(
  paymentsRepo: PaymentsRepository,
  row: PaymentRequestRow,
  projectId: string,
  custodyWalletId: string,
  found: FoundPayment
): Promise<PaymentTransferRow> {
  const [existing] = await paymentsRepo.listTransfersBySignatures({
    signatures: [found.signature],
    organizationId: row.organization_id,
    projectId,
  });
  if (existing) {
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
}
