// Shared SWR cache-key helpers for the token control-list (allowlist/denylist),
// so the fetching component and the mutation hook agree on keys and the hook can
// cross-revalidate every cached page + the labels facet after add/remove.

export const TOKEN_ALLOWLIST_KEY = "token-allowlist";
export const TOKEN_ALLOWLIST_LABELS_KEY = "token-allowlist-labels";

// Matches every cached allowlist list page and the labels entry for a token,
// regardless of the active search / label / page-size window.
export function isTokenAllowlistKey(key: unknown, tokenId: string): boolean {
  return (
    Array.isArray(key) &&
    (key[0] === TOKEN_ALLOWLIST_KEY || key[0] === TOKEN_ALLOWLIST_LABELS_KEY) &&
    key[1] === tokenId
  );
}
