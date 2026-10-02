export const custodyQueryKeys = {
  walletActivity: ({ walletId }: { walletId: string }) => ["wallet-activity", walletId] as const,
  /** One page of a wallet's `/v1/transactions` feed, keyed by the exact query it asks. */
  walletTransactions: ({ apiQuery }: { apiQuery: string }) =>
    ["wallet-transactions", apiQuery] as const,
  policyDestinationAccounts: () => "policy-destination-accounts",
  walletPolicyRevisions: ({ walletId }: { walletId: string }) =>
    ["wallet-policy-revisions", walletId] as const,
};
