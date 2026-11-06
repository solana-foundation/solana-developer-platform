export const accountQueryKeys = {
  sessions: ({ userId }: { userId: string }) => ["account-sessions", userId] as const,
};
