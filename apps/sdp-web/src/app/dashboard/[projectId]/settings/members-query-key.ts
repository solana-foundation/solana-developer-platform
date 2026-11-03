export const membersQueryKeys = {
  memberApiKeys: ({ memberId }: { memberId: string }) => ["member-api-keys", memberId] as const,
};
