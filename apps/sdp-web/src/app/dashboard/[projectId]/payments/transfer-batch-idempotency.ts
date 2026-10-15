"use client";

import type { PaymentTransferBatchRequest } from "@sdp/types";
import { uncertainMoneyAnswerMessage } from "@/lib/idempotency";
import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
  settleMoneyIdempotencyKey,
} from "@/lib/idempotency-key-store";
import {
  type CreateTransferBatchResult,
  createTransferBatch,
  TransferBatchRequestError,
  type Translate,
} from "./payments-workspace.data";

/**
 * Browser-side durability for the transfer-batch IDEMPOTENCY KEY.
 *
 * `POST /v1/payments/transfer-batches` replays by Idempotency-Key + payload
 * fingerprint, but only when the caller carries a key at all: an unkeyed retry
 * is a brand-new batch that moves the whole amount again. Storage and
 * the retire rule are the shared key store's (`lib/idempotency-key-store.ts`),
 * as for single transfers; this module owns what makes two batches the same one.
 */

const store = createIdempotencyKeyStore("sdp:payments:transfer-batch:idempotency:v1");

/** @internal Test-only: clear the module-scope tiers so specs are order-independent. */
export function resetTransferBatchIdempotencyStateForTests(): void {
  resetIdempotencyKeyStoresForTests();
}

/**
 * The request in canonical form: recipients ordered by account id.
 *
 * The client treats re-selecting the same recipients in a different order as
 * the SAME intent, but the API fingerprints resolved recipients IN ORDER. Left
 * to diverge, a retry that reorders the list (remove a recipient, add it back)
 * carries the same key with a differently-ordered body, which the API refuses
 * as a fingerprint conflict — and that refusal (422) is what retires the key,
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
  return store.claim(fingerprint).key;
}

/**
 * Retire a key once the API has answered for it: a recorded batch, or a
 * definitive refusal ({@link sendTransferBatchUnderKey}).
 */
export function releaseTransferBatchIdempotencyKey(fingerprint: string, key: string): void {
  store.release(fingerprint, key);
}

/**
 * Sends one batch under the key that makes a retry a retry: claimed and pinned
 * before the request goes out (a batch whose key storage refused is not sent;
 * see `createTransferBatch`), and retired only on the dashboard-wide rule
 * (`moneyAnswerRetiresKey`): a recorded batch, a replay or a 422 retires it, and
 * anything else keeps it, since an earlier attempt may have paid every
 * recipient. A 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` or a 422
 * `IDEMPOTENCY_KEY_REUSED` keeps it too and tells the user to check the list.
 *
 * @param request - The batch, in canonical form.
 * @param t - Translator, for the API's refusal message.
 * @returns The recorded batch.
 */
export async function sendTransferBatchUnderKey(
  request: PaymentTransferBatchRequest,
  t: Translate
): Promise<CreateTransferBatchResult> {
  const fingerprint = transferBatchRequestFingerprint(request);
  const { key, persisted } = store.claim(fingerprint);
  let result: CreateTransferBatchResult;
  try {
    result = await createTransferBatch(request, t, { value: key, persisted });
  } catch (error) {
    if (error instanceof TransferBatchRequestError) {
      const answer = { status: error.status, replayed: error.replayed, code: error.code };
      settleMoneyIdempotencyKey(store, fingerprint, key, answer);
      const uncertain = uncertainMoneyAnswerMessage(answer);
      if (uncertain !== null) {
        // The key is kept, so the next press is answered under it: send nothing new.
        throw new TransferBatchRequestError(t(uncertain), error.status, error.replayed, error.code);
      }
    }
    throw error;
  }
  // The batch row exists, so the key is spent: the next identical batch is a
  // new intent rather than a retry of this one.
  releaseTransferBatchIdempotencyKey(fingerprint, key);
  return result;
}
