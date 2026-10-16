"use client";

import type { PaymentTransferSummary as TransferRecord } from "@sdp/types";
import { uncertainMoneyAnswerMessage } from "@/lib/idempotency";
import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
  settleMoneyIdempotencyKey,
} from "@/lib/idempotency-key-store";
import {
  type CreateTransferInput,
  createTransfer,
  TransferRequestError,
  type Translate,
} from "./payments-workspace.data";

/**
 * Browser-side durability for a single transfer's IDEMPOTENCY KEY.
 *
 * Without a key, pressing Send again after a timeout is a new payment to the
 * API, and both can send the money. With the same key the API's replay finds
 * the first transfer and sends nothing more. Storage and the
 * retire rule are the shared store's; this module owns what makes two sends
 * the same payment.
 */

const store = createIdempotencyKeyStore("sdp:payments:transfer:idempotency:v1");
type TransferSendResult = { transfer: TransferRecord; fingerprint: string };
const pendingSends = new Map<string, Promise<TransferSendResult>>();

/** @internal Test-only: clear the module-scope tiers so specs are order-independent. */
export function resetTransferIdempotencyStateForTests(): void {
  resetIdempotencyKeyStoresForTests();
  pendingSends.clear();
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
  return store.claim(fingerprint).key;
}

/** Retire the key once an answer retires it (`answerRetiresKey`). */
export function releaseTransferIdempotencyKey(fingerprint: string, key: string): void {
  store.release(fingerprint, key);
}

/**
 * Sends one transfer under the key that makes a retry a retry.
 *
 * Every caller needs the same steps in the same order, and each one exists
 * because of a way one payment becomes two: claim the key before the request
 * goes out, and retire it once the API has answered.
 *
 * @param submission - The payment.
 * @param t - Translator, for the API's refusal message.
 * @returns What the API answered, and the fingerprint of the payment.
 */
async function performTransferUnderKey(
  submission: CreateTransferInput,
  t: Translate,
  fingerprint: string,
  providerSession: boolean
): Promise<TransferSendResult> {
  const { key, persisted } = store.claim(fingerprint);
  let transfer: TransferRecord;
  try {
    transfer = await createTransfer(submission, t, { value: key, persisted });
  } catch (error) {
    // A provider may repeat its signature callback after a lost event response,
    // and its session always names the same payment, so its key is never
    // released. Otherwise the money rule decides (`moneyAnswerRetiresKey`).
    if (!providerSession && error instanceof TransferRequestError) {
      const answer = { status: error.status, replayed: error.replayed, code: error.code };
      settleMoneyIdempotencyKey(store, fingerprint, key, answer);
      const uncertain = uncertainMoneyAnswerMessage(answer);
      if (uncertain !== null) {
        // The key is kept, so the next press is answered under it: send nothing new.
        throw new TransferRequestError(t(uncertain), error.status, error.replayed, error.code);
      }
    }
    throw error;
  }
  if (!providerSession) {
    // The transfer row exists, so the key is spent: the next identical send is a
    // new payment rather than a retry of this one.
    releaseTransferIdempotencyKey(fingerprint, key);
  }
  return { transfer, fingerprint };
}

/** Joins simultaneous submissions before either can release or claim a key. */
export function sendTransferUnderKey(
  submission: CreateTransferInput,
  t: Translate,
  providerSessionId?: string
): Promise<TransferSendResult> {
  const payment = transferRequestFingerprint(submission);
  const fingerprint =
    providerSessionId === undefined ? payment : JSON.stringify([providerSessionId, payment]);
  const pending = pendingSends.get(fingerprint);
  if (pending) return pending;
  const send = performTransferUnderKey(
    submission,
    t,
    fingerprint,
    providerSessionId !== undefined
  ).finally(() => {
    if (pendingSends.get(fingerprint) === send) pendingSends.delete(fingerprint);
  });
  pendingSends.set(fingerprint, send);
  return send;
}
