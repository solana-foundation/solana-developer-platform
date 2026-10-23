/**
 * Records the movements SDP builds (ADR 0012): each owning row and its legs in
 * one transaction. A new row's legacy `amount` text is written here, and in
 * the batch repository, only from the quote (`ownWalletAmount`).
 */

import type { MovementQuote } from "@sdp/solana/movement-quote";
import { toTokenAmount } from "@sdp/solana/token-amount";
import { asTransactionalClient, type DatabaseClient } from "@/db/client";
import type {
  CreatePaymentTransferInput,
  PaymentsRepository,
  PaymentTransferRow,
} from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import {
  createPostgresTokenMovementLegsRepository,
  ownWalletAmount,
} from "@/db/repositories/token-movement-legs.repository";
import { internalError } from "@/lib/errors";
import type { TenantScope } from "@/lib/tenant-scope";

/**
 * Writes an outbound transfer row and its leg together. The row's `amount` is
 * the quote's debit.
 *
 * @throws The database error of either write; neither is kept.
 */
export async function recordQuotedTransfer(
  db: DatabaseClient,
  tenant: TenantScope,
  transfer: Omit<CreatePaymentTransferInput, "amount">,
  quote: MovementQuote
): Promise<PaymentTransferRow> {
  return db.transaction(async (tx) => {
    const txClient = asTransactionalClient(tx);
    const created = await createPostgresPaymentsRepository(txClient, tenant).createTransfer({
      ...transfer,
      amount: ownWalletAmount(quote),
    });
    if (created === null) {
      throw internalError("Failed to create payment transfer record");
    }
    await createPostgresTokenMovementLegsRepository(tx, tenant).insertLegs([
      { owner: { kind: "transfer", transferId: created.id }, quote },
    ]);
    return created;
  });
}

/**
 * Claims an awaiting off-ramp row for its deposit and records the deposit's
 * leg in the same transaction. The provider's deposit amount is a receipt, so
 * the quote is a credit; the claim compares the row against that credit. A
 * deposit claimed again after a release replaces its earlier quote.
 *
 * @returns The claimed row, or null when the claim's compare-and-swap matched no row.
 */
export async function claimOfframpDepositWithLeg(
  db: DatabaseClient,
  tenant: TenantScope,
  claim: Omit<Parameters<PaymentsRepository["updateOnchainTransferForRamp"]>[0], "credit">,
  quote: MovementQuote
): Promise<PaymentTransferRow | null> {
  return db.transaction(async (tx) => {
    const txClient = asTransactionalClient(tx);
    const claimed = await createPostgresPaymentsRepository(
      txClient,
      tenant
    ).updateOnchainTransferForRamp({
      ...claim,
      credit: toTokenAmount(quote.credit, quote.decimals).value,
    });
    if (claimed === null) {
      return null;
    }
    const leg = await createPostgresTokenMovementLegsRepository(tx, tenant).upsertTransferLeg({
      owner: { kind: "transfer", transferId: claimed.id },
      quote,
    });
    if (leg === null) {
      // The claim matched only an unsigned row, so its leg cannot be sealed.
      throw internalError("The claimed off-ramp deposit's leg is sealed");
    }
    return claimed;
  });
}
