export const quickStartQueryKeys = {
  // Per project: the wallet step reads the open project's wallets.
  status: (projectId: string) => `dashboard-quick-start-status:${projectId}`,
};
