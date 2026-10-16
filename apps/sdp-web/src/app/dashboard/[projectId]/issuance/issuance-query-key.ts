import type { Arguments } from "swr";
import { TOKEN_ALLOWLIST_KEY } from "./[tokenId]/asset-profile/allowlist-cache";
import { TOKEN_TRANSACTIONS_KEY } from "./[tokenId]/asset-profile/transactions-cache";
import type { IssuanceListQuery } from "./issuance-list-query";

const TOKEN_ACTIVITY_KEY = "token-activity-redesign";
const LATEST_DEPLOYS_KEY = "issuance-latest-deploys";
const TOKENS_KEY = "issuance-tokens";

export const issuanceQueryKeys = {
  createTokenSignerWallets: () => "issuance-create-token-signer-wallets",
  tokens: ({ query }: { query: IssuanceListQuery }) => [TOKENS_KEY, query] as const,
  isTokensKey: (key: Arguments) => Array.isArray(key) && key[0] === TOKENS_KEY,
  /** The latest deploy of each listed token that has no mint yet. */
  latestDeploys: ({ tokenIds }: { tokenIds: readonly string[] }) =>
    [LATEST_DEPLOYS_KEY, tokenIds] as const,
  /** One window of a token's audit history on the new design's activity tab. */
  tokenActivity: ({
    tokenId,
    page,
    pageSize,
    action,
    status,
    actorType,
  }: {
    tokenId: string;
    page: number;
    pageSize: number;
    action?: string | undefined;
    status?: string | undefined;
    actorType?: string | undefined;
  }) => [TOKEN_ACTIVITY_KEY, tokenId, page, pageSize, action, status, actorType] as const,
  /** The window an audit-history key asks for; null for any other key. */
  tokenActivityPage: (key: Arguments): number | null =>
    Array.isArray(key) && key[0] === TOKEN_ACTIVITY_KEY && typeof key[2] === "number"
      ? key[2]
      : null,
  /** One page of a token's transactions on the new design's operations tab. */
  tokenTransactions: ({
    tokenId,
    page,
    pageSize,
  }: {
    tokenId: string;
    page: number;
    pageSize: number;
  }) => [TOKEN_TRANSACTIONS_KEY, tokenId, page, pageSize, "redesign"] as const,
  /** One page of a token's access list on the new design's compliance tab. */
  tokenAllowlist: ({
    tokenId,
    page,
    pageSize,
  }: {
    tokenId: string;
    page: number;
    pageSize: number;
  }) => [TOKEN_ALLOWLIST_KEY, tokenId, page, pageSize, "", ""] as const,
  authorityWallets: ({ tokenId }: { tokenId: string }) =>
    ["token-management-authority-wallets", tokenId] as const,
  isWalletInventoryKey: (key: Arguments) =>
    Array.isArray(key) && key[0] === "token-management-authority-wallets",
};
