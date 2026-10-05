import type { Arguments } from "swr";

const WALLET_CARD_BALANCE_FALLBACK_PREFIX = "wallet-card-balance-fallback:";

export const custodyQueryKeys = {
  walletActivity: ({ walletId }: { walletId: string }) => ["wallet-activity", walletId] as const,
  /** One page of a wallet's `/v1/transactions` feed, keyed by the exact query it asks. */
  walletTransactions: ({ apiQuery }: { apiQuery: string }) =>
    ["wallet-transactions", apiQuery] as const,
  /** Keyed to the server read so a later visit never starts from an earlier visit's cache. */
  walletBalances: ({ walletId, readAt }: { walletId: string; readAt: number }) =>
    ["wallet-balances", walletId, readAt] as const,
  walletCardBalances: () => "wallet-card-balances",
  walletCardBalanceFallback: ({ walletId }: { walletId: string }) =>
    `${WALLET_CARD_BALANCE_FALLBACK_PREFIX}${walletId}`,
  /** Balances and activity of any wallet, as shown on the wallet pages (either Activity read). */
  isWalletLiveDataKey: (key: Arguments) =>
    (Array.isArray(key) &&
      (key[0] === "wallet-balances" ||
        key[0] === "wallet-activity" ||
        key[0] === "wallet-transactions")) ||
    key === custodyQueryKeys.walletCardBalances() ||
    (typeof key === "string" && key.startsWith(WALLET_CARD_BALANCE_FALLBACK_PREFIX)),
  policyDestinationAccounts: () => "policy-destination-accounts",
  walletPolicyRevisions: ({ walletId }: { walletId: string }) =>
    ["wallet-policy-revisions", walletId] as const,
};
