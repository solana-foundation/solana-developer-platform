export const membersQueryKeys = {
  linkedPayments: (memberId: string) => ["member-linked-payments", memberId] as const,
};
