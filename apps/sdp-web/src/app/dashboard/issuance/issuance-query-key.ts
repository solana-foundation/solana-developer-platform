import type { IssuanceListQuery } from "./issuance-list-query";

export const issuanceQueryKeys = {
  createTokenSignerWallets: () => "issuance-create-token-signer-wallets",
  tokens: ({ query }: { query: IssuanceListQuery }) => ["issuance-tokens", query] as const,
};
