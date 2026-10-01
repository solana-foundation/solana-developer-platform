import type { Arguments } from "swr";

export const custodyQueryKeys = {
  walletActivity: ({ walletId }: { walletId: string }) => ["wallet-activity", walletId] as const,
  /** Keyed to the server read so a later visit never starts from an earlier visit's cache. */
  walletBalances: ({ walletId, readAt }: { walletId: string; readAt: number }) =>
    ["wallet-balances", walletId, readAt] as const,
  /** Balances and activity of any wallet, as shown on the wallet pages. */
  isWalletLiveDataKey: (key: Arguments) =>
    (Array.isArray(key) && (key[0] === "wallet-balances" || key[0] === "wallet-activity")) ||
    key === "wallet-card-balances" ||
    (typeof key === "string" && key.startsWith("wallet-card-balance-fallback:")),
  policyDestinationAccounts: () => "policy-destination-accounts",
  walletPolicyRevisions: ({ walletId }: { walletId: string }) =>
    ["wallet-policy-revisions", walletId] as const,
};
