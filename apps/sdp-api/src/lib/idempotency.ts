import { createHash } from "node:crypto";
import { conflict } from "@/lib/errors";

/**
 * Turn a caller's `Idempotency-Key` into the stable request id a provider
 * dedupes on.
 *
 * For a keyed insert SDP owns (payments transfers), replay is resolved against
 * our own row and its fingerprint. A provider-executed money movement that SDP
 * stores no row for has no such anchor — the PROVIDER is the only party that
 * can collapse a duplicate, and it does so on the request id it was sent. So
 * the caller's key has to survive into that id unchanged across retries, which
 * `crypto.randomUUID()` by definition cannot: a fresh id per attempt is a fresh
 * money movement.
 *
 * Derivation is a SHA-256 over the scope plus the key. Scope parts keep the
 * same key in two different places from colliding into one provider request;
 * they are length-prefixed so no combination of parts can be rearranged into
 * another.
 *
 * The result is stamped as version FOUR even though it is derived rather than
 * random, because providers validate the shape: Ground answers a version-5
 * UUID with `400 requestId must be a valid UUID v4` (verified against their
 * sandbox, 2026-08-05), which would turn every header-keyed withdrawal into a
 * rejected request. Version 5 is the semantically correct label for a
 * name-derived value, so this is a deliberate concession to the wire format,
 * not a claim of randomness. Collision resistance comes from SHA-256, not from
 * the version nibble.
 */
export function deriveProviderRequestId(scope: readonly string[], key: string): string {
  const material = [...scope, key].map((part) => `${part.length}:${part}`).join("|");
  const hash = createHash("sha256").update(material).digest("hex");
  // RFC 4122 variant: high bits 10xx, i.e. one of 8/9/a/b.
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

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
