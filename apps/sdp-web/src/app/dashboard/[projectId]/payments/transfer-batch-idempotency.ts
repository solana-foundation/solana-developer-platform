"use client";

import {
  isPartiallyFailedTransferBatchStatus,
  type PaymentTransferBatchRequest,
} from "@sdp/types/payments";
import { MOVEMENT_READ_PATHS, settleWhenMovementFinal } from "@/lib/dashboard-fetch";
import { canonicalDecimalAmount, uncertainMoneyAnswerMessage } from "@/lib/idempotency";
import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
  settleMoneyIdempotencyKey,
} from "@/lib/idempotency-key-store";
import {
  type CreateTransferBatchResult,
  createTransferBatch,
  retryTransferBatch,
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
const retryStore = createIdempotencyKeyStore("sdp:payments:transfer-batch-retry:idempotency:v1");

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
 *
 * Each amount is spelled canonically too, as the API fingerprints it: a retry
 * that re-enters `1` for `1.0` is the same batch under the same key.
 */
export function canonicalTransferBatchRequest(
  request: PaymentTransferBatchRequest
): PaymentTransferBatchRequest {
  return {
    ...request,
    recipients: request.recipients
      .map((recipient) => ({ ...recipient, amount: canonicalDecimalAmount(recipient.amount) }))
      .sort((a, b) => a.counterpartyAccountId.localeCompare(b.counterpartyAccountId)),
  };
}

/**
 * What makes two submissions the SAME batch: the source wallet, the token,
 * every recipient with its amount (in canonical spelling), and the external reference. Change any one
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

/** 32-bit FNV-1a of a string, as 8 hex digits: a short, stable digest, not a secret. */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The payout run reference the dashboard sends when the user leaves Reference
 * blank (HOO-2335): the day plus a digest of the wallet, token and recipients
 * with their amounts. The same batch sent again that day, from any browser or
 * by another operator, names the same run, so the API answers it with the
 * first batch or refuses it (409) instead of paying everyone again. A real
 * second identical payout the same day needs a reference of its own.
 *
 * @param request - The batch without a reference.
 * @param day - The local calendar day, `YYYY-MM-DD`.
 */
export function defaultTransferBatchReference(
  request: PaymentTransferBatchRequest,
  day: string
): string {
  const { externalId: _ignored, ...rest } = request;
  return `batch-${day}-${fnv1aHex(transferBatchRequestFingerprint(rest))}`;
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
 * (`moneyAnswerRetiresKey`): a recorded batch no longer processing, a replay or a 422 retires it, and
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
  // Sent in the form it is keyed by, whatever form the caller passed.
  const canonical = canonicalTransferBatchRequest(request);
  const fingerprint = transferBatchRequestFingerprint(canonical);
  const { key, persisted } = store.claim(fingerprint);
  let result: CreateTransferBatchResult;
  try {
    result = await createTransferBatch(canonical, t, { value: key, persisted });
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
  // The batch row exists, so once it is final the key is spent and the next
  // identical batch is a new intent. While it is still processing the key is
  // kept, so that send is answered by the replay (APE-461); a partially failed
  // batch keeps it for good (APE-462): sending it again would pay the paid
  // recipients twice, so its failed ones are finished with a retry.
  if (isPartiallyFailedTransferBatchStatus(result.batch.status)) return result;
  const settled = settleMoneyIdempotencyKey(store, fingerprint, key, {
    status: 200,
    replayed: false,
    code: null,
    movementStatus: result.batch.status,
  });
  // A replay repeats the first answer verbatim, so only a read of the batch's
  // current state can show it final and settle the key.
  if (!settled) {
    settleWhenMovementFinal(MOVEMENT_READ_PATHS.batch(result.batch.id), (status) => {
      if (!isPartiallyFailedTransferBatchStatus(status)) store.release(fingerprint, key);
    });
  }
  return result;
}

/** What makes two retry presses the SAME retry: the batch, and the recipients it found failed. */
export function transferBatchRetryFingerprint(
  batchId: string,
  failedRecipientIds: readonly string[]
): string {
  return JSON.stringify([batchId, [...failedRecipientIds].sort()]);
}

/**
 * Retries a batch's failed recipients under a key kept per batch and failed
 * set, so a double press, a timeout or a reload is answered by the first
 * retry instead of sending again. The API records the retry under its key
 * before it sends anything, so a same-key press after a timeout or a 5xx is
 * answered from that record (HOO-2343). A recorded answer retires the key at
 * once, even while the resent recipients are processing: the API only ever
 * sends recipients that are failed when it runs, so a later retry under a new
 * key cannot pay anyone twice, and if they fail again the same failed set
 * must not be answered by this retry. An uncertain answer keeps the key, as
 * for a send.
 *
 * @param batchId - The batch to retry.
 * @param failedRecipientIds - Its recipients the dashboard last read as failed.
 * @param t - Translator, for the API's refusal message.
 * @returns The batch after the retry.
 */
export async function retryTransferBatchUnderKey(
  batchId: string,
  failedRecipientIds: readonly string[],
  t: Translate
): Promise<CreateTransferBatchResult> {
  const fingerprint = transferBatchRetryFingerprint(batchId, failedRecipientIds);
  const { key, persisted } = retryStore.claim(fingerprint);
  try {
    const retried = await retryTransferBatch(batchId, t, { value: key, persisted });
    retryStore.release(fingerprint, key);
    return retried;
  } catch (error) {
    if (error instanceof TransferBatchRequestError) {
      const answer = { status: error.status, replayed: error.replayed, code: error.code };
      settleMoneyIdempotencyKey(retryStore, fingerprint, key, answer);
      const uncertain = uncertainMoneyAnswerMessage(answer);
      if (uncertain !== null) {
        throw new TransferBatchRequestError(t(uncertain), error.status, error.replayed, error.code);
      }
    }
    throw error;
  }
}
