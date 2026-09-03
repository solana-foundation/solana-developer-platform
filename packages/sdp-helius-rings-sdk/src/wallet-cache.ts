import type { Wallet } from "@heliuslabs/zolana/transaction";

/**
 * In-process wallet cache: one decrypted Zolana `Wallet` per Rings identity,
 * keyed by walletId. First sync of any wallet in a process is a full scan;
 * subsequent syncs on the same wallet reuse the object so Zolana's per-tag
 * cursors advance in place.
 *
 * A restart pays a full scan again until Zolana's `serializeWallet` includes
 * cursor state — which the SDK's own docstring flags as an intended addition.
 */
const cache = new Map<string, CacheEntry>();

interface CacheEntry {
  readonly wallet: Wallet;
  /** Re-provisioning changes the identity; the fingerprint mismatch drops it. */
  readonly fingerprint: string;
}

export function getCachedWallet(walletId: string, fingerprint: string): Wallet | undefined {
  const entry = cache.get(walletId);
  return entry && entry.fingerprint === fingerprint ? entry.wallet : undefined;
}

export function setCachedWallet(walletId: string, wallet: Wallet, fingerprint: string): void {
  cache.set(walletId, { wallet, fingerprint });
}

export function invalidateCachedWallet(walletId: string): void {
  cache.delete(walletId);
}

/** Test seam; production callers should never need this. */
export function clearWalletCache(): void {
  cache.clear();
}
