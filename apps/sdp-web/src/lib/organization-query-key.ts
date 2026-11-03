export const organizationQueryKeys = {
  /** The person's Clerk organizations this deployment does not link, asked about together. */
  unlinkedOrganizations: ({
    userId,
    organizationIds,
  }: {
    userId: string;
    organizationIds: readonly string[];
  }) => ["unlinked-organizations", userId, ...organizationIds] as const,
};
