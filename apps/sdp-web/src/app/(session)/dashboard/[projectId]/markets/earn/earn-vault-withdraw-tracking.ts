"use client";

import {
  createFloorMemo,
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "@/lib/idempotency-key-store";

/**
 * The vault WITHDRAWAL idempotency key store — the deposit store's mirror
 * (PRO-1702), sharing every durability rule through
 * `@/lib/idempotency-key-store.ts`. A retry inside the record-before-broadcast
 * window must carry the same key or the chain accepts the same exit twice.
 */
export const vaultWithdrawalIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:earn:vault-withdrawal:idempotency:v1"
);

/**
 * Test-only: clear the shared module-scope tiers so specs are
 * order-independent. Production never calls this.
 *
 * @internal
 */
export function resetVaultWithdrawalTrackingStateForTests(): void {
  resetIdempotencyKeyStoresForTests();
  vaultWithdrawalFloorMemo.resetForTests();
  vaultWithdrawalSharesMemo.resetForTests();
}

/**
 * What makes two submissions the SAME exit: the PROJECT, the position, the
 * user's TYPED quantity, and the user's slippage tolerance. Change any one and
 * it is a different withdrawal, not a retry. The position carries the vault
 * and the signing wallet transitively — a holding is one (org, environment,
 * provider, vault, wallet) claim — so naming it is naming both, and the
 * project is here for the same replay-scope reason the deposit fingerprint
 * documents.
 *
 * The TYPED quantity — the dollar amount an atomic exit starts from, the
 * shares a provider order starts from — is in here in place of the share
 * intent the API receives, for the same reason the tolerance is in here in
 * place of the floor: the fingerprint must be reproducible from user input
 * while a key stays held. An atomic exit DERIVES its shares from the live
 * position value, which the positions polls re-read every few seconds — a
 * fingerprint on the derived shares drifts under a kept key, the retry misses
 * it, mints a SECOND key, and that submit can exit again while the first
 * attempt may already have executed. The typed quantity is stable across
 * every poll. The derived shares the key actually went out with are
 * remembered SEPARATELY (`rememberVaultWithdrawalShares`) and replayed
 * verbatim, because the API's own idempotency fingerprint includes `shares`
 * and refuses a replay whose body changed — exactly the refusal that retires
 * the key and unlocks the second exit above.
 */
export function vaultWithdrawalRequestFingerprint(input: {
  redemptionMode?: "standard" | "instant";
  /** `null` only before a project resolves; it still discriminates. */
  projectId: string | null;
  positionId: string;
  /**
   * What the customer typed: the dollar amount for an atomic exit, the exact
   * shares for a provider order — canonicalized, so a re-entry finds the key.
   */
  quantity: string;
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
  const identity = [input.projectId, input.positionId, input.quantity, input.toleranceBps];
  if (input.redemptionMode !== undefined) identity.push(input.redemptionMode);
  return JSON.stringify(identity);
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

/**
 * The share intent each kept fingerprint's key was MINTED with — the same
 * story as the floor memo beside it: an atomic exit's shares are DERIVED from
 * the live position value, so they cannot be re-derived reliably when a kept
 * key's retry comes back, and the API's fingerprint pins `shares` anyway. A
 * provider order's shares are its typed input, so only the atomic path
 * depends on this memo — but recording what actually went out, always, keeps
 * the replay honest by construction.
 */
const vaultWithdrawalSharesMemo = createFloorMemo("sdp:earn:vault-withdrawal:shares:v1");

/** Record the share intent `fingerprint`'s key is being submitted with. */
export function rememberVaultWithdrawalShares(fingerprint: string, shares: string): void {
  vaultWithdrawalSharesMemo.remember(fingerprint, shares);
}

/** The remembered share intent, or `undefined` when nothing is remembered. */
export function recallVaultWithdrawalShares(fingerprint: string): string | null | undefined {
  return vaultWithdrawalSharesMemo.recall(fingerprint);
}

/**
 * Drop a retired key's shares so the next fresh derivation cannot inherit it,
 * only once no key is kept for the fingerprint (see `forgetVaultDepositFloor`).
 */
export function forgetVaultWithdrawalShares(fingerprint: string): void {
  if (vaultWithdrawalIdempotencyKeyStore.has(fingerprint)) return;
  vaultWithdrawalSharesMemo.forget(fingerprint);
}

/**
 * Drop a retired key's floor so the next fresh derivation cannot inherit it,
 * only once no key is kept for the fingerprint (see `forgetVaultDepositFloor`).
 */
export function forgetVaultWithdrawalFloor(fingerprint: string): void {
  if (vaultWithdrawalIdempotencyKeyStore.has(fingerprint)) return;
  vaultWithdrawalFloorMemo.forget(fingerprint);
}
