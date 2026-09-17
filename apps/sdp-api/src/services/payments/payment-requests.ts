import type { Signature } from "@sdp/rpc/solana";
import * as solanaRpc from "@sdp/rpc/solana";
import { verifyTransactionLanded } from "@sdp/rpc/verified-confirmation";
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

export function isPaymentRequestExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

/**
 * Minimum time between on-chain reference checks for the same payment
 * request on one API instance. Read paths that reconcile many rows at once
 * (the payment requests list) pass this so a page view does not fire one
 * billed RPC round trip per awaiting request; payer-facing flows omit it so
 * payment status stays immediate.
 */
export const PAYMENT_REQUEST_CHAIN_CHECK_MIN_INTERVAL_MS = 30_000;

/**
 * Last chain-check time per request id, stamped just before the RPC round
 * trip so concurrent reads within the interval share one check. Entries are
 * dropped once a reconcile observes a terminal state or an invariant
 * violation, so the map only holds ids of awaiting requests recently seen.
 */
const chainCheckedAtByRequestId = new Map<string, number>();

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
 *   retries. An unresolved legacy wallet also returns the stored row because
 *   the exact-identity backfill intentionally leaves ambiguous rows unpinned.
 *   Other invariant violations (AppError) always rethrow — they do
 *   not self-heal and must not hide behind a stale row. When false, every
 *   failure rethrows, for paths that must not act on stale state.
 * @param options.minChainCheckIntervalMs - When set, skips the chain check
 *   when the request was already checked within this interval on this API
 *   instance and returns the stored row. Bounds the billed RPC cost of
 *   fan-out reads that reconcile every row of a page, at the cost of
 *   detecting a landed payment up to one interval later on those reads.
 *   Leave unset where status must reflect the chain on every read.
 * @returns The settled row when a valid payment was found, otherwise the
 *   stored row.
 */
export async function reconcilePaymentRequest(
  env: Env,
  row: PaymentRequestRow,
  options: { bestEffort: boolean; minChainCheckIntervalMs?: number }
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment") {
    chainCheckedAtByRequestId.delete(row.id);
    return row;
  }
  if (isPaymentRequestExpired(row.expires_at)) {
    chainCheckedAtByRequestId.delete(row.id);
    return row;
  }
  if (row.custody_wallet_id === null) {
    if (options.bestEffort) {
      return row;
    }
    throw new AppError("CONFLICT", "Payment request wallet identity is unresolved");
  }

  const lastChainCheckedAt = chainCheckedAtByRequestId.get(row.id);
  if (
    options.minChainCheckIntervalMs !== undefined &&
    lastChainCheckedAt !== undefined &&
    Date.now() - lastChainCheckedAt < options.minChainCheckIntervalMs
  ) {
    return row;
  }
  chainCheckedAtByRequestId.set(row.id, Date.now());

  try {
    return await settlePaymentRequestIfPaid(env, row, row.custody_wallet_id);
  } catch (err) {
    if (!options.bestEffort || err instanceof AppError) {
      // Never memoize a failed invariant check: the next read must surface
      // it again instead of serving the stale row.
      chainCheckedAtByRequestId.delete(row.id);
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
  row: PaymentRequestRow,
  custodyWalletId: string
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

  const verified = await verifyTransactionLanded(rpc, found.signature as unknown as Signature);
  if (!verified.ok) {
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
    if (
      existing.custody_wallet_id !== row.custody_wallet_id ||
      existing.wallet_id !== row.wallet_id ||
      existing.counterparty_id !== row.counterparty_id ||
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
