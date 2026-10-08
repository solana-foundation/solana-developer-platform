"use client";

import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";

export type EarnVaultAsyncWithdrawalIntent = {
  projectId: string;
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
} & (
  | { shares: string; intermediateAmount?: undefined }
  /** A par request over the position's held intermediate. */
  | { intermediateAmount: string; shares?: undefined }
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
  // key with a shares request for the same number; shares keys are unchanged.
  const common =
    input.intermediateAmount === undefined
      ? [input.projectId, input.positionId, input.shares, input.route.kind]
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
