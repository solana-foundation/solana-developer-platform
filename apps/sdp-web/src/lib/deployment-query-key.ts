export const deploymentQueryKeys = {
  sandboxOnly: ({ organizationId }: { organizationId: string }) =>
    ["deployment-sandbox-only", organizationId] as const,
};
