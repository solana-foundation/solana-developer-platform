import type { Arguments } from "swr";
import type { IssuanceListQuery } from "./issuance-list-query";

export const issuanceQueryKeys = {
  createTokenSignerWallets: () => "issuance-create-token-signer-wallets",
  tokens: ({ query }: { query: IssuanceListQuery }) => ["issuance-tokens", query] as const,
  authorityWallets: ({ tokenId }: { tokenId: string }) =>
    ["token-management-authority-wallets", tokenId] as const,
  supportingData: ({ tokenId }: { tokenId: string }) =>
    ["token-management-supporting-data", tokenId] as const,
  isWalletInventoryKey: (key: Arguments) =>
    Array.isArray(key) &&
    (key[0] === "token-management-authority-wallets" ||
      key[0] === "token-management-supporting-data"),
};
