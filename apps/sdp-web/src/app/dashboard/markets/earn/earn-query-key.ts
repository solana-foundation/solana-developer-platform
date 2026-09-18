export const earnQueryKeys = {
  programs: () => "dashboard-earn-programs",
  strategies: ({ cluster }: { cluster: string }) => ["dashboard-earn-strategies", cluster] as const,
  vaultPositions: () => "dashboard-earn-vault-positions",
  vaultDepositsInFlight: () => "dashboard-earn-vault-deposits-in-flight",
  vaultDeposit: ({ movementId }: { movementId: string }) =>
    ["dashboard-earn-vault-deposit", movementId] as const,
  vaultWithdrawalsInFlight: () => "dashboard-earn-vault-withdrawals-in-flight",
  vaultWithdrawal: ({ movementId }: { movementId: string }) =>
    ["dashboard-earn-vault-withdrawal", movementId] as const,
  vaultWithdrawalRequestsOpen: () => "dashboard-earn-vault-withdrawal-requests-open",
  vaultWithdrawalRequest: ({ withdrawalRequestId }: { withdrawalRequestId: string }) =>
    ["dashboard-earn-vault-withdrawal-request", withdrawalRequestId] as const,
  programWithdrawals: ({ programId }: { programId: string }) =>
    ["dashboard-earn-program-withdrawals", programId] as const,
  withdrawal: ({ programId, withdrawalRef }: { programId: string; withdrawalRef: string }) =>
    ["dashboard-earn-withdrawal", programId, withdrawalRef] as const,
  fundingWallets: () => "dashboard-earn-funding-wallets",
};
