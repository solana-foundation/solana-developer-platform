"use client";

import { createFloorMemo, createIdempotencyKeyStore } from "./earn-idempotency-key-store";

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
  /**
   * The USER'S slippage tolerance, or `null` when the provider takes no
   * derived floor — never the derived floor itself, for the reason the
   * deposit fingerprint documents: the fingerprint must be reproducible from
   * user input after a reload, and a quote-derived floor is not. "Raise the
   * tolerance and retry" still mints a fresh key. The floor a HELD key was
   * minted with is remembered separately (`rememberVaultWithdrawalFloor`) and
   * replayed verbatim, because the API's own fingerprint includes
   * `minAmountOut` and refuses a replay whose floor changed.
   */
  toleranceBps: number | null;
}): string {
  return JSON.stringify([input.projectId, input.positionId, input.shares, input.toleranceBps]);
}

/** The exit twin of the deposit's floor memo — see `createFloorMemo`. */
const vaultWithdrawalFloorMemo = createFloorMemo("sdp:earn:vault-withdrawal:floor:v1");

/** Record the floor `fingerprint`'s key is being submitted with. */
export function rememberVaultWithdrawalFloor(
  fingerprint: string,
  minAmountOut: string | null
): void {
  vaultWithdrawalFloorMemo.remember(fingerprint, minAmountOut);
}

/** The remembered floor, `null` for "deliberately none", `undefined` for nothing. */
export function recallVaultWithdrawalFloor(fingerprint: string): string | null | undefined {
  return vaultWithdrawalFloorMemo.recall(fingerprint);
}

/** Drop a retired key's floor so the next fresh derivation cannot inherit it. */
export function forgetVaultWithdrawalFloor(fingerprint: string): void {
  vaultWithdrawalFloorMemo.forget(fingerprint);
}

/**
 * Test-only: clear this flow's memo tier so specs are order-independent.
 *
 * @internal
 */
export function resetVaultWithdrawalTrackingStateForTests(): void {
  vaultWithdrawalFloorMemo.resetForTests();
}
