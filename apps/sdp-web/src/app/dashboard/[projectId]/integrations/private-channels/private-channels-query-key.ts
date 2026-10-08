export const privateChannelsQueryKeys = {
  deposit: (id: string) => ["private-channel-deposit", id] as const,
  withdrawal: (id: string) => ["private-channel-withdrawal", id] as const,
};
