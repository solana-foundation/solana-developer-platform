export const custodyQueryKeys = {
  walletActivity: ({ walletId }: { walletId: string }) => ["wallet-activity", walletId] as const,
  policyDestinationAccounts: () => "policy-destination-accounts",
  walletPolicyRevisions: ({ walletId }: { walletId: string }) =>
    ["wallet-policy-revisions", walletId] as const,
};
