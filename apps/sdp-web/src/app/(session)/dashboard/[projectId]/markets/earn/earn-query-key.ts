export const earnQueryKeys = {
  operations: () => "dashboard-earn-core-operations",
  operation: (id: string) => ["dashboard-earn-operation", id] as const,
  strategies: ({ cluster }: { cluster: string }) => ["dashboard-earn-strategies", cluster] as const,
  vaultPositions: () => "dashboard-earn-vault-positions",
  fundingWallets: () => "dashboard-earn-funding-wallets",
  kaminoAllocations: ({ vaults }: { vaults: string }) =>
    ["dashboard-earn-kamino-allocations", vaults] as const,
};
