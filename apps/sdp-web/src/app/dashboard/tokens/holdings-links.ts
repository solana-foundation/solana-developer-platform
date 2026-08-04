/**
 * Where a holding's activity lives.
 *
 * The transactions table already filters by asset — `TransactionFilters.asset`
 * serializes to the API's `token` query param, and the page parses `?asset=` back
 * out of the URL. So a per-token history needs no new surface; the holding only
 * needs to point at the filter that already exists.
 *
 * `parseTrimmed(..., 64)` bounds the value on the way in, so anything longer is
 * truncated here rather than silently dropped there.
 */
const ASSET_FILTER_MAX_LENGTH = 64;

export function tokenActivityHref(symbol: string): string {
  const asset = symbol.trim().slice(0, ASSET_FILTER_MAX_LENGTH);
  if (!asset) {
    return "/dashboard/payments/transactions";
  }
  return `/dashboard/payments/transactions?asset=${encodeURIComponent(asset)}`;
}
