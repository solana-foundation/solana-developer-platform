// Shared SWR cache-key helpers for the token transactions browser, so the
// fetching component and the operations mutation hook agree on keys and the hook
// can cross-revalidate every cached page after a mint/burn/etc.

export const TOKEN_TRANSACTIONS_KEY = "token-transactions";

// Matches every cached transactions page for a token, regardless of the active
// type / status / page-size window.
export function isTokenTransactionsKey(key: unknown, tokenId: string): boolean {
  return Array.isArray(key) && key[0] === TOKEN_TRANSACTIONS_KEY && key[1] === tokenId;
}
