"use client";

import {
  APPROVAL_REQUEST_STATUSES,
  canReleaseApprovalPaymentKey,
  WALLET_OPERATION_STATUSES,
} from "@sdp/types";
import { z } from "zod";
import {
  createPaymentIdempotencyStore,
  isIdempotencyKeyConflict,
} from "./payment-idempotency-store";
import {
  type CreateTransferInput,
  type CreateTransferOutcome,
  createTransfer,
  TransferRequestError,
  type Translate,
} from "./payments-workspace.data";

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
type TransferSendResult = { outcome: CreateTransferOutcome; fingerprint: string };
const pendingSends = new Map<string, Promise<TransferSendResult>>();

/** @internal Test-only: clear the module-scope tiers so specs are order-independent. */
export function resetTransferIdempotencyStateForTests(): void {
  store.resetForTests();
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
  return store.claim(fingerprint);
}

/** Pin the key while an approval holds the payment; the approval can take hours. */
export function holdTransferIdempotencyKey(fingerprint: string, approvalRequestId: string): void {
  store.hold(fingerprint, approvalRequestId);
}

const approvalStatusSchema = z.object({
  data: z.object({
    approvalRequest: z.looseObject({
      status: z.enum(APPROVAL_REQUEST_STATUSES),
      operation: z.looseObject({ status: z.enum(WALLET_OPERATION_STATUSES) }).optional(),
    }),
  }),
});

/**
 * Lifts the hold once the approval that caused it has finished, so the next
 * identical payment is a new payment rather than a replay of the old one.
 *
 * A held key is pinned for as long as its approval can still execute, because
 * the executor replays the original request under it. Once the approval is
 * rejected, cancelled, expired, or approved and finished executing, that is no
 * longer true, and keeping the key would answer a genuinely new payment with
 * the old transfer.
 *
 * Anything unreadable leaves the hold in place: keeping a key too long costs a
 * replay the API reports, and dropping one too early costs a second payment.
 *
 * @param fingerprint - What makes two sends the same payment.
 */
export async function releaseSettledTransferHold(fingerprint: string): Promise<void> {
  const approvalRequestId = store.heldApproval(fingerprint);
  if (approvalRequestId === null) {
    return;
  }
  let body: unknown;
  try {
    const response = await fetch(
      `/api/dashboard/approval-requests/${encodeURIComponent(approvalRequestId)}`,
      { cache: "no-store" }
    );
    if (!response.ok) {
      return;
    }
    body = await response.json();
  } catch {
    return;
  }
  const parsed = approvalStatusSchema.safeParse(body);
  if (!parsed.success) {
    return;
  }
  const { status, operation } = parsed.data.data.approvalRequest;
  if (canReleaseApprovalPaymentKey(status, operation?.status)) {
    store.release(fingerprint);
  }
}

/** Retire the key once the API recorded the transfer or refused it with a 4xx. */
export function releaseTransferIdempotencyKey(fingerprint: string): void {
  store.release(fingerprint);
}

/** A 409 under our own key is the one 4xx that must keep it. */
export function isTransferKeyConflict(status: number): boolean {
  return isIdempotencyKeyConflict(status);
}

/**
 * Sends one transfer under the key that makes a retry a retry.
 *
 * Every caller needs the same four steps in the same order, and each one exists
 * because of a way one payment becomes two: lift a hold whose approval has
 * finished, claim the key before the request goes out, keep the key when an
 * approval parks the payment, and retire it once the API has answered.
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
  if (!providerSession) await releaseSettledTransferHold(fingerprint);
  const idempotencyKey = claimTransferIdempotencyKey(fingerprint);
  // A provider may repeat its signature callback after a lost event response.
  // Its session still names the same payment, even after the transfer lands.
  if (providerSession) store.hold(fingerprint);
  let outcome: CreateTransferOutcome;
  try {
    outcome = await createTransfer(submission, t, idempotencyKey);
  } catch (error) {
    // A 4xx is a definitive refusal and frees the key. A 5xx or a network
    // failure keeps it: the API may have recorded the transfer before the
    // answer was lost. A 409 under our own key keeps it too.
    if (
      error instanceof TransferRequestError &&
      error.status >= 400 &&
      error.status < 500 &&
      !isTransferKeyConflict(error.status)
    ) {
      releaseTransferIdempotencyKey(fingerprint);
    }
    throw error;
  }
  if (outcome.kind === "approval_pending") {
    // The approval executor replays this request under the same key, so the key
    // outlives the person deciding.
    holdTransferIdempotencyKey(fingerprint, outcome.approvalRequestId);
  } else if (!providerSession) {
    // The transfer row exists, so the key is spent: the next identical send is a
    // new payment rather than a retry of this one.
    releaseTransferIdempotencyKey(fingerprint);
  }
  return { outcome, fingerprint };
}

/** Joins simultaneous submissions before either can release or claim a held key. */
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
