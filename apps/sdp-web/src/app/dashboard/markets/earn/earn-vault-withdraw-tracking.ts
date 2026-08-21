"use client";

import { createIdempotencyKeyStore } from "./earn-idempotency-key-store";

/**
 * The vault WITHDRAWAL idempotency key store — the deposit store's mirror
 * (PRO-1702), sharing every durability rule through
 * `earn-idempotency-key-store.ts`. A retry inside the record-before-broadcast
 * window must carry the same key or the chain accepts the same exit twice; an
 * approval hold pins the key for as long as a human may take.
 */
export const vaultWithdrawalIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:earn:vault-withdrawal:idempotency:v1"
);

/**
 * What makes two submissions the SAME exit: the PROJECT, the position, and the
 * share quantity. Change any one and it is a different withdrawal, not a
 * retry. The position carries the vault and the signing wallet transitively —
 * a holding is one (org, environment, provider, vault, wallet) claim — so
 * naming it is naming both, and the project is here for the same
 * organization-level custody-config reason the deposit fingerprint documents.
 */
export function vaultWithdrawalRequestFingerprint(input: {
  /** `null` only before a project resolves; it still discriminates. */
  projectId: string | null;
  positionId: string;
  shares: string;
}): string {
  return JSON.stringify([input.projectId, input.positionId, input.shares]);
}
