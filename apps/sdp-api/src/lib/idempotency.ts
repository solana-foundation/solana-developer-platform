export const normalizeForFingerprint = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForFingerprint);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(source)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nestedValue]) => [key, normalizeForFingerprint(nestedValue)])
    );
  }

  return value;
};

export interface PaymentTransferFingerprintInput {
  sourceAddress: string | null;
  destinationAddress: string | null;
  token: string;
  amount: string | null;
  memo: string | null | undefined;
  type: string;
  privateTransfer?: unknown;
}

export const buildPaymentTransferFingerprint = (input: PaymentTransferFingerprintInput): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "payment_transfer",
      sourceAddress: input.sourceAddress,
      destinationAddress: input.destinationAddress,
      token: input.token,
      amount: input.amount,
      memo: input.memo ?? null,
      type: input.type,
      privateTransfer: input.privateTransfer ?? null,
    })
  );
