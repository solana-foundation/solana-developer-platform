"use client";

import {
  createPaymentIdempotencyStore,
  isIdempotencyKeyConflict,
} from "./payment-idempotency-store";
import type { CreateTransferInput } from "./payments-workspace.data";

/**
 * Browser-side durability for a single transfer's IDEMPOTENCY KEY.
 *
 * Without a key, pressing Send again after a timeout, or on a payment a policy
 * is holding for approval, is a new payment to the API: it opens another
 * approval request, and approving both sends the money twice. With the same key
 * the approval executor's replay finds the first transfer and sends nothing
 * more. Storage, expiry and holds are the shared store's; this module owns what
 * makes two sends the same payment.
 */

const store = createPaymentIdempotencyStore("sdp:payments:transfer:idempotency:v1");

/** @internal Test-only: clear the module-scope tiers so specs are order-independent. */
export function resetTransferIdempotencyStateForTests(): void {
  store.resetForTests();
}

/**
 * What makes two sends the SAME payment: the source wallet, the destination, the
 * token, the amount and the memo. Change any one and it is a different payment,
 * not a retry.
 */
export function transferRequestFingerprint(input: CreateTransferInput): string {
  return JSON.stringify([
    input.sourceCustodyWalletId,
    input.destination,
    input.token,
    input.amount,
    input.memo === undefined ? null : input.memo,
  ]);
}

/** The key for this payment, the same one on every retry until it is released. */
export function claimTransferIdempotencyKey(fingerprint: string): string {
  return store.claim(fingerprint);
}

/** Pin the key while an approval holds the payment; the approval can take hours. */
export function holdTransferIdempotencyKey(fingerprint: string): void {
  store.hold(fingerprint);
}

/** Retire the key once the API recorded the transfer or refused it with a 4xx. */
export function releaseTransferIdempotencyKey(fingerprint: string): void {
  store.release(fingerprint);
}

/** A 409 under our own key is the one 4xx that must keep it. */
export function isTransferKeyConflict(status: number): boolean {
  return isIdempotencyKeyConflict(status);
}
