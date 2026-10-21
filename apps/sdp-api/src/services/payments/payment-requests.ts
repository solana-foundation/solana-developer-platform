import { createClusterRpc } from "@sdp/rpc/factory";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { verifyTransactionLanded } from "@sdp/rpc/verified-confirmation";
import { assertValidAddress } from "@sdp/solana/address";
import { toNumberAmount } from "@sdp/solana/amount";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Address } from "@solana/kit";
import { ValidateTransferError, validateTransfer } from "@solana/pay";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
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
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

/**
 * How long past its expiry a payment request still settles. `/pay` stops building transactions
 * at expiry, and every transaction it built lands within ~150 blocks of its blockhash or never, so
 * a payment from one built just before expiry still finalizes inside this window.
 */
export const PAYMENT_REQUEST_SETTLEMENT_GRACE_MS = 5 * 60 * 1000;

/**
 * How long past expiry the final check must run: a payment that lands at the settlement
 * deadline has finalized well within one more grace window, so a check after this sees it.
 */
export const PAYMENT_REQUEST_FINAL_CHECK_AFTER_MS = 2 * PAYMENT_REQUEST_SETTLEMENT_GRACE_MS;

/** Signatures read per reference; a reference carries its payment and little else. */
const REFERENCE_SIGNATURE_LIMIT = 25;

type ReferenceSignature = Awaited<
  ReturnType<ReturnType<SolanaRpc["getSignaturesForAddress"]>["send"]>
>[number];

export function isPaymentRequestExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

/**
 * The instant after which a payment no longer settles the request: expiry plus
 * {@link PAYMENT_REQUEST_SETTLEMENT_GRACE_MS}, or null for a request that never expires.
 *
 * @param row - The payment request.
 * @returns The settlement deadline in epoch milliseconds, or null.
 */
function settlementDeadlineMs(row: PaymentRequestRow): number | null {
  return row.expires_at === null
    ? null
    : Date.parse(row.expires_at) + PAYMENT_REQUEST_SETTLEMENT_GRACE_MS;
}

/**
 * Whether the reconciler has already made the final check, {@link PAYMENT_REQUEST_FINAL_CHECK_AFTER_MS}
 * past expiry, so nothing further can settle the request: a payment that landed in time had
 * finalized and was visible to that check.
 *
 * @param row - The payment request.
 * @returns `true` once the final check has run.
 */
function isSettlementWindowClosed(row: PaymentRequestRow): boolean {
  return (
    row.expires_at !== null &&
    row.last_checked_at !== null &&
    Date.parse(row.last_checked_at) >
      Date.parse(row.expires_at) + PAYMENT_REQUEST_FINAL_CHECK_AFTER_MS
  );
}

/**
 * Checks the chain for a finalized transaction referencing this payment
 * request and, when a valid payment is found, records the inbound transfer and
 * marks the request paid. An expired request still settles on a payment that
 * landed within {@link PAYMENT_REQUEST_SETTLEMENT_GRACE_MS} of its expiry,
 * however late it is checked.
 *
 * Reads the chain on the open cluster scope's cluster (the row's Project).
 *
 * @param env - API environment for database access.
 * @param row - The stored payment request row to reconcile.
 * @param options.bestEffort - When true, unexpected infra failures (e.g. an
 *   RPC outage) degrade to the stored row with a log so one bad row cannot
 *   take down a whole list read or the public pay page; the next read
 *   retries. An unresolved legacy wallet also returns the stored row because
 *   the exact-identity backfill intentionally leaves ambiguous rows unpinned.
 *   Other invariant violations (AppError) always rethrow — they do
 *   not self-heal and must not hide behind a stale row. When false, every
 *   failure rethrows, for paths that must not act on stale state.
 * @returns The settled row when a valid payment was found, otherwise the
 *   stored row.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope, or
 *   `RPC_NOT_CONFIGURED` when the cluster has no endpoint, even when best-effort.
 */
export async function reconcilePaymentRequest(
  env: Env,
  row: PaymentRequestRow,
  options: { bestEffort: boolean }
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment") {
    return row;
  }
  if (isSettlementWindowClosed(row)) {
    return row;
  }
  if (row.custody_wallet_id === null) {
    if (options.bestEffort) {
      return row;
    }
    throw new AppError("CONFLICT", "Payment request wallet identity is unresolved");
  }

  const rpc = createClusterRpc();
  try {
    return await settlePaymentRequestIfPaid(env, rpc, row, row.custody_wallet_id);
  } catch (err) {
    if (!options.bestEffort || err instanceof AppError) {
      throw err;
    }
    getLogger().error(
      {
        payment_request_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "reconcilePaymentRequest: best-effort reconcile failed, returning stored row"
    );
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
  rpc: SolanaRpc,
  row: PaymentRequestRow,
  custodyWalletId: string
): Promise<PaymentRequestRow> {
  const projectId = row.project_id;
  // TODO: once migration 0129 makes payment_requests.project_id NOT NULL (HOO-1966), narrow PaymentRequestRow.project_id to string and delete this guard.
  if (projectId === null) {
    throw internalError("payment_requests row is missing project_id");
  }

  const reference = assertValidAddress(row.reference, "reference");

  const found = await findFirstValidPayment(rpc, row, reference);
  if (found === null) {
    return row;
  }

  const transfer = await recordInboundTransfer(env, row, projectId, custodyWalletId, found);

  const scope = createTenantScope({
    organizationId: row.organization_id,
    projectId,
  });
  const requestsRepo = createPaymentRequestsRepository(env, scope);
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
 * The oldest finalized transaction on the request's reference that landed, before the settlement
 * deadline when the request expires, and pays the request: the right recipient, amount and mint.
 * The reference is public, so anyone can name it in a transaction of their own; a failed,
 * late or non-paying one is skipped, never taken as the payment.
 *
 * @param rpc - Solana RPC on the request's cluster.
 * @param row - The payment request.
 * @param reference - The request's reference account.
 * @returns The paying transaction's signature entry, or null when none pays the request yet.
 */
async function findFirstValidPayment(
  rpc: SolanaRpc,
  row: PaymentRequestRow,
  reference: Address
): Promise<ReferenceSignature | null> {
  // NOTE: a reference flooded with more than REFERENCE_SIGNATURE_LIMIT successful transactions
  // after its payment hides the payment from this read; the money still lands in the wallet.
  const signatures = await rpc
    .getSignaturesForAddress(reference, {
      commitment: "finalized",
      limit: REFERENCE_SIGNATURE_LIMIT,
    })
    .send();
  const deadline = settlementDeadlineMs(row);
  for (const candidate of [...signatures].reverse()) {
    if (candidate.err !== null) {
      continue;
    }
    if (
      deadline !== null &&
      (candidate.blockTime === null || Number(candidate.blockTime) * 1000 > deadline)
    ) {
      continue;
    }
    const verified = await verifyTransactionLanded(rpc, candidate.signature);
    if (!verified.ok) {
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
      return candidate;
    }
  }
  return null;
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
  found: ReferenceSignature
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
