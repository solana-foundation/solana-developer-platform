/** One Tokens.xyz snapshot row for mocked display-price responses. */
export function tokensPriceRow(address: string, price: number, lastFetchedAt = Date.now()) {
  return { address, hasMarket: true, token: { address, price, lastFetchedAt } };
}
