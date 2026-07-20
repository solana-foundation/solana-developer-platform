import type { CustodyWalletSummary } from "@sdp/types";

export const WALLET_SEARCH_QUERY_PARAM = "query";
export const WALLET_SEARCH_MAX_LENGTH = 200;

export function normalizeWalletSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").slice(0, WALLET_SEARCH_MAX_LENGTH);
}

export function filterWallets(
  wallets: CustodyWalletSummary[],
  query: string
): CustodyWalletSummary[] {
  const tokens = normalizeWalletSearchQuery(query).toLocaleLowerCase().split(" ").filter(Boolean);
  if (tokens.length === 0) return wallets;

  return wallets.filter((wallet) => {
    const searchableText = [
      wallet.label,
      wallet.walletId,
      wallet.publicKey,
      wallet.provider,
      wallet.purpose,
      wallet.status,
      wallet.isDefaultProvider ? "default" : null,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();

    return tokens.every((token) => searchableText.includes(token));
  });
}
