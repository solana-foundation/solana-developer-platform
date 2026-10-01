import type { Arguments } from "swr";

export const custodyQueryKeys = {
  walletActivity: ({ walletId }: { walletId: string }) => ["wallet-activity", walletId] as const,
  walletBalances: ({ walletId }: { walletId: string }) => ["wallet-balances", walletId] as const,
  /** Balances and activity of any wallet, as shown on the wallet pages. */
  isWalletLiveDataKey: (key: Arguments) =>
    (Array.isArray(key) && (key[0] === "wallet-balances" || key[0] === "wallet-activity")) ||
    key === "wallet-card-balances",
  policyDestinationAccounts: () => "policy-destination-accounts",
  walletPolicyRevisions: ({ walletId }: { walletId: string }) =>
    ["wallet-policy-revisions", walletId] as const,
};
