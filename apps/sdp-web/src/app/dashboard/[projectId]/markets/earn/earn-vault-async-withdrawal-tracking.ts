"use client";

import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";

export type EarnVaultAsyncWithdrawalIntent = {
  projectId: string | null;
  positionId: string;
  route:
    | {
        kind: "queue";
        discountBps: number;
        deadlineSeconds: number;
      }
    | {
        kind: "operator_redemption";
      };
} /**
 * The CANONICAL TYPED stablecoin amount the shares are derived from —
 * never the shares themselves. The queued and par exits convert the typed
 * amount to shares through the position's live value, so fingerprinting
 * the shares would move the fingerprint with every rate tick and mint a
 * fresh key for one retried intent — the double exit the key store exists
 * to refuse. The typed amount is reproducible after a reload, which is the
 * store's cross-reload guarantee; under a replayed key the API
 * fingerprint-checks the request it actually receives, so a rate move
 * between the attempts is a refused conflict, never a second request.
 */ & (
  | { amount: string; intermediateAmount?: undefined }
  /** A par request over the position's held intermediate, typed one-for-one. */
  | { intermediateAmount: string; amount?: undefined }
);

/**
 * Durable per-tab keys for asynchronous custody exits. Keep the original
 * storage key so an in-flight request survives the product-level rename.
 */
export const vaultAsyncWithdrawalIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:earn:vault-queued-withdrawal:idempotency:v1"
);

/** Every user-controlled field, including the asynchronous route mechanism. */
export function vaultAsyncWithdrawalRequestFingerprint(
  input: EarnVaultAsyncWithdrawalIntent
): string {
  // A held-intermediate request carries its own marker, so it never shares a
  // key with a typed-amount request for the same number; amount keys are
  // unchanged in meaning (the typed input the shares were derived from).
  const common =
    input.intermediateAmount === undefined
      ? [input.projectId, input.positionId, input.amount, input.route.kind]
      : [
          input.projectId,
          input.positionId,
          input.intermediateAmount,
          input.route.kind,
          "intermediate",
        ];
  return JSON.stringify(
    input.route.kind === "queue"
      ? [...common, input.route.discountBps, input.route.deadlineSeconds]
      : common
  );
}
