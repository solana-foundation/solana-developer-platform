/**
 * Where a holding's activity lives.
 *
 * The transactions table already filters by asset — `TransactionFilters.asset`
 * serializes to the API's `token` query param — so a per-token history needs no
 * new surface, only a link into the filter that exists.
 *
 * 🚨 Takes a **mint address, not a symbol.** The filter is an exact match on
 * `pt.token` (`payments.repository.postgres.ts:97`), and that column stores the
 * mint: `payment-requests.ts:105` compares it to `SOL_MINT` and otherwise runs it
 * through `assertValidAddress`. Passing "SOL" produced `WHERE pt.token = 'SOL'`,
 * which matches nothing, so the table came back empty or unfiltered.
 *
 * `parseTrimmed(..., 64)` bounds the value on the way in; a base58 mint is 32-44
 * characters, so it fits.
 */
const ASSET_FILTER_MAX_LENGTH = 64;

export function tokenActivityHref(mint: string): string {
  const asset = mint.trim().slice(0, ASSET_FILTER_MAX_LENGTH);
  if (!asset) {
    return "/dashboard/payments/transactions";
  }
  return `/dashboard/payments/transactions?asset=${encodeURIComponent(asset)}`;
}
