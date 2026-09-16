"use client";

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
export function holdTransferIdempotencyKey(fingerprint: string, approvalRequestId: string): void {
  store.hold(fingerprint, approvalRequestId);
}

/** A decided approval: its request will not execute again under the held key. */
const SETTLED_APPROVAL_STATUSES = new Set(["rejected", "canceled", "expired", "failed"]);

const approvalStatusSchema = z.object({
  data: z.object({
    approvalRequest: z.looseObject({
      status: z.string().min(1),
      operation: z.looseObject({ status: z.string().min(1) }).optional(),
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
  const finished =
    SETTLED_APPROVAL_STATUSES.has(status) ||
    (status === "approved" && operation?.status !== undefined && operation.status !== "executing");
  if (finished) {
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
 * @returns What the API answered, and the fingerprint, so a caller that keeps
 *   going (a widget mid-flow) can release the key itself.
 */
export async function sendTransferUnderKey(
  submission: CreateTransferInput,
  t: Translate
): Promise<{ outcome: CreateTransferOutcome; fingerprint: string }> {
  const fingerprint = transferRequestFingerprint(submission);
  await releaseSettledTransferHold(fingerprint);
  const idempotencyKey = claimTransferIdempotencyKey(fingerprint);
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
    holdTransferIdempotencyKey(fingerprint, outcome.approvalRequestId);
  }
  return { outcome, fingerprint };
}
