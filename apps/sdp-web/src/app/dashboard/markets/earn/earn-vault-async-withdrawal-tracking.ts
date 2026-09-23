"use client";

import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";

export type EarnVaultAsyncWithdrawalIntent = {
  projectId: string | null;
  positionId: string;
  shares: string;
  route:
    | {
        kind: "queue";
        discountBps: number;
        deadlineSeconds: number;
      }
    | {
        kind: "operator_redemption";
      };
};

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
  const common = [input.projectId, input.positionId, input.shares, input.route.kind];
  return JSON.stringify(
    input.route.kind === "queue"
      ? [...common, input.route.discountBps, input.route.deadlineSeconds]
      : common
  );
}
