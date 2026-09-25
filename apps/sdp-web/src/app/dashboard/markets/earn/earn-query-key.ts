/**
 * Every Earn collection key names the Dashboard Project the tab rendered with.
 * The BFF resolves request scope from the shared `sdp_selected_project_id`
 * cookie, which another tab can move at any time — a project-free key let one
 * project's cached yield state render under another project's label
 * (APE-777). The project is part of the key so a cache entry can never be
 * served to a tab rendering a different project, and the same value rides the
 * request itself (`x-sdp-rendered-project-id`) so the BFF refuses responses
 * whose resolved request project has moved on. Detail keys carry it too: a
 * detail poll follows the shared cookie exactly like its collection read.
 */
export interface EarnQueryScope {
  projectId: string;
}

export const earnQueryKeys = {
  programs: ({ projectId }: EarnQueryScope) => ["dashboard-earn-programs", projectId] as const,
  strategies: ({ projectId, cluster }: EarnQueryScope & { cluster: string }) =>
    ["dashboard-earn-strategies", projectId, cluster] as const,
  vaultPositions: ({ projectId }: EarnQueryScope) =>
    ["dashboard-earn-vault-positions", projectId] as const,
  vaultDepositsInFlight: ({ projectId }: EarnQueryScope) =>
    ["dashboard-earn-vault-deposits-in-flight", projectId] as const,
  vaultDeposit: ({ projectId, movementId }: EarnQueryScope & { movementId: string }) =>
    ["dashboard-earn-vault-deposit", projectId, movementId] as const,
  vaultWithdrawalsInFlight: ({ projectId }: EarnQueryScope) =>
    ["dashboard-earn-vault-withdrawals-in-flight", projectId] as const,
  vaultWithdrawal: ({ projectId, movementId }: EarnQueryScope & { movementId: string }) =>
    ["dashboard-earn-vault-withdrawal", projectId, movementId] as const,
  vaultWithdrawalRequestsOpen: ({ projectId }: EarnQueryScope) =>
    ["dashboard-earn-vault-withdrawal-requests-open", projectId] as const,
  vaultWithdrawalRequest: ({
    projectId,
    withdrawalRequestId,
  }: EarnQueryScope & { withdrawalRequestId: string }) =>
    ["dashboard-earn-vault-withdrawal-request", projectId, withdrawalRequestId] as const,
  programWithdrawals: ({ projectId, programId }: EarnQueryScope & { programId: string }) =>
    ["dashboard-earn-program-withdrawals", projectId, programId] as const,
  withdrawal: ({
    projectId,
    programId,
    withdrawalRef,
  }: EarnQueryScope & { programId: string; withdrawalRef: string }) =>
    ["dashboard-earn-withdrawal", projectId, programId, withdrawalRef] as const,
  fundingWallets: ({ projectId }: EarnQueryScope) =>
    ["dashboard-earn-funding-wallets", projectId] as const,
  externalWalletSummary: ({ projectId }: EarnQueryScope) =>
    ["dashboard-earn-external-wallet-position-summary", projectId] as const,
};

/** Whether a SWR key is the funding-wallets collection of any project scope. */
export function isFundingWalletsKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === "dashboard-earn-funding-wallets";
}
