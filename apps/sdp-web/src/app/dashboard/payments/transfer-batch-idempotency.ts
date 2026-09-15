"use client";

import type { PaymentTransferBatchRequest } from "@sdp/types";
import {
  createPaymentIdempotencyStore,
  isIdempotencyKeyConflict,
} from "./payment-idempotency-store";

/**
 * Browser-side durability for the transfer-batch IDEMPOTENCY KEY.
 *
 * `POST /v1/payments/transfer-batches` replays by Idempotency-Key + payload
 * fingerprint, but only when the caller carries a key at all: an unkeyed retry
 * is a brand-new batch that moves the whole amount again. The storage, expiry
 * and hold mechanics live in `payment-idempotency-store.ts`, shared with single
 * transfers; this module owns what makes two batches the same one.
 */

const store = createPaymentIdempotencyStore("sdp:payments:transfer-batch:idempotency:v1");

/** @internal Test-only: clear the module-scope tiers so specs are order-independent. */
export function resetTransferBatchIdempotencyStateForTests(): void {
  store.resetForTests();
}

/**
 * The request in canonical form: recipients ordered by account id.
 *
 * The client treats re-selecting the same recipients in a different order as
 * the SAME intent, but the API fingerprints resolved recipients IN ORDER. Left
 * to diverge, a retry that reorders the list (remove a recipient, add it back)
 * carries the same key with a differently-ordered body, which the API refuses
 * as a fingerprint conflict — and a refusal is exactly what retires the key,
 * so the next press mints a fresh one and sends a SECOND batch for a request
 * that may already be recorded.
 *
 * Sending this form closes that: one intent has one body, so a retry is
 * byte-identical and the API replays the recorded batch instead of conflicting.
 * Recipient order carries no meaning to a batch — the same accounts receive
 * the same amounts either way.
 */
export function canonicalTransferBatchRequest(
  request: PaymentTransferBatchRequest
): PaymentTransferBatchRequest {
  return {
    ...request,
    recipients: [...request.recipients].sort((a, b) =>
      a.counterpartyAccountId.localeCompare(b.counterpartyAccountId)
    ),
  };
}

/**
 * What makes two submissions the SAME batch: the source wallet, the token,
 * every recipient with its amount, and the external reference. Change any one
 * and it is a different batch, not a retry. Recipients are read in canonical
 * order, which is also the order they are SENT in, so this key and the API's
 * own order-sensitive fingerprint agree on what one intent is.
 */
export function transferBatchRequestFingerprint(request: PaymentTransferBatchRequest): string {
  const canonical = canonicalTransferBatchRequest(request);
  return JSON.stringify([
    canonical.projectId ?? null,
    canonical.externalId ?? null,
    canonical.sourceCustodyWalletId,
    canonical.token,
    canonical.recipients.map((recipient) => [
      recipient.counterpartyId,
      recipient.counterpartyAccountId,
      recipient.amount,
    ]),
    canonical.options ?? null,
  ]);
}

/**
 * The idempotency key for this batch, minting and persisting one the first time.
 * The same batch rebuilt after a retry or a reload gets the SAME key.
 */
export function claimTransferBatchIdempotencyKey(fingerprint: string): string {
  return store.claim(fingerprint);
}

/**
 * Pin a key while a policy approval holds the batch (202 SIGNING_PENDING). The
 * approval executor replays the ORIGINAL request with this exact key, so it
 * must outlive the human deciding.
 */
export function holdTransferBatchIdempotencyKey(fingerprint: string): void {
  store.hold(fingerprint);
}

/**
 * Retire a key once the API has answered for it: a recorded batch, or a 4xx
 * refusal other than a key conflict. Never on a 5xx or a network failure.
 */
export function releaseTransferBatchIdempotencyKey(fingerprint: string): void {
  store.release(fingerprint);
}

/** A 409 under our own key is the one 4xx that must keep it. */
export function isTransferBatchKeyConflict(status: number): boolean {
  return isIdempotencyKeyConflict(status);
}
