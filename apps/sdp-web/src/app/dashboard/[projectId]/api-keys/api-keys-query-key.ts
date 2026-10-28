export const apiKeysQueryKeys = {
  linkedPayments: (keyId: string) => ["api-key-linked-payments", keyId] as const,
};
