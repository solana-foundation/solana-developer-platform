import { conflict } from "@/lib/errors";

/**
 * Resolves an idempotent replay for a keyed insert: returns the existing row
 * when its stored fingerprint matches the incoming request, null when no row
 * has claimed the key yet, and throws CONFLICT when the key was already used
 * with a different request payload. A stored row without a fingerprint is
 * treated as unclaimed rather than a conflict, so the caller's insert surfaces
 * the inconsistent row as a loud unique-violation error instead of a 409.
 */
export async function resolveIdempotencyReplay<
  Row extends { idempotency_fingerprint: string | null },
>(findExisting: () => Promise<Row | null>, fingerprint: string): Promise<Row | null> {
  const existing = await findExisting();
  if (!existing || existing.idempotency_fingerprint === null) {
    return null;
  }
  if (existing.idempotency_fingerprint === fingerprint) {
    return existing;
  }
  throw conflict("Idempotency key already used with different request payload");
}

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
  counterpartyId?: string;
  token: string;
  amount: string | null;
  memo: string | null | undefined;
  type: string;
  privateTransfer?: unknown;
}

export interface TransferBatchFingerprintRecipientInput {
  externalId: string | null;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: string;
  amount: string;
}

export interface TransferBatchFingerprintInput {
  sourceAddress: string;
  token: string;
  recipients: TransferBatchFingerprintRecipientInput[];
  options: Record<string, unknown> | undefined;
}

export const buildPaymentTransferFingerprint = (input: PaymentTransferFingerprintInput): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "payment_transfer",
      sourceAddress: input.sourceAddress,
      destinationAddress: input.destinationAddress,
      counterpartyId: input.counterpartyId,
      token: input.token,
      amount: input.amount,
      memo: input.memo ?? null,
      type: input.type,
      privateTransfer: input.privateTransfer ?? null,
    })
  );

export const buildTransferBatchFingerprint = (input: TransferBatchFingerprintInput): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "payment_transfer_batch",
      sourceAddress: input.sourceAddress,
      token: input.token,
      recipients: input.recipients,
      options: input.options ?? null,
    })
  );
