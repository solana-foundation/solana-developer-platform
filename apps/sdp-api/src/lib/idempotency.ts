import { createHash } from "node:crypto";
import { normalizeDecimalString } from "@sdp/types/idempotency";
import { z } from "zod";
import { conflict } from "@/lib/errors";

/**
 * Turn a caller's `Idempotency-Key` into the stable request id a provider
 * dedupes on.
 *
 * For a keyed insert SDP owns (payments transfers, earn withdrawal intents),
 * replay is resolved against our own row and its fingerprint. For a
 * provider-executed money movement the provider ALSO dedupes on the request id
 * it was sent — that second layer is what closes the crash window between our
 * insert and the provider's acceptance. So the caller's key has to survive
 * into that id unchanged across retries, which `crypto.randomUUID()` by
 * definition cannot: a fresh id per attempt is a fresh money movement.
 *
 * Derivation is a SHA-256 over the scope plus the key. Scope parts keep the
 * same key in two different places from colliding into one provider request;
 * they are length-prefixed so no combination of parts can be rearranged into
 * another.
 *
 * The result is stamped as version FOUR even though it is derived rather than
 * random, because providers validate the shape: a provider answered a version-5
 * UUID with `400 requestId must be a valid UUID v4`, which would turn every
 * header-keyed withdrawal into a rejected request. Version 5 is the
 * semantically correct label for a name-derived value, so this is a deliberate
 * concession to the wire format, not a claim of randomness. Collision
 * resistance comes from SHA-256, not from the version nibble.
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

/**
 * A replayed row still `pending` this long after its last write was abandoned
 * mid-flight: the process died between the reserving insert and the broadcast,
 * and private channels have no reconciliation worker to recover it. Replaying
 * such a row verbatim would pin the operation to `pending` forever, so callers
 * fail it instead, freeing the client to retry under a new idempotency key. The
 * window sits far above the broadcast + confirm budget (seconds) so a live
 * request can never be failed out from under itself, and the callers' `pending`
 * status CAS backstops that race regardless of the clock.
 */
const ABANDONED_RESERVATION_AFTER_MS = 10 * 60 * 1000;

export function isAbandonedReservation(row: { status: string; updated_at: string }): boolean {
  return (
    row.status === "pending" &&
    Date.now() - Date.parse(row.updated_at) >= ABANDONED_RESERVATION_AFTER_MS
  );
}

/** A JSON value as `JSON.parse` returns it; parse untrusted values through it. */
export const jsonValueSchema = z.json();

export type JsonValue = z.infer<typeof jsonValueSchema>;

/**
 * For an Idempotency-Key fingerprint (HOO-1918): the body with each named
 * decimal-string field spelled canonically, so "1.0" and "1" are one request.
 * A field that is not a string is left as sent; validation already ran.
 */
export function canonicalizeDecimalFields(body: JsonValue, fields: readonly string[]): JsonValue {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const canonical = { ...body };
  for (const field of fields) {
    const value = canonical[field];
    if (typeof value === "string") {
      canonical[field] = normalizeDecimalString(value);
    }
  }
  return canonical;
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

export interface EarnVaultQueuedWithdrawalFingerprintInput {
  environment: string;
  provider: string;
  positionId: string;
  shares: string;
  discountBps: number;
  deadlineSeconds: number;
  /** Exact unsigned build consumed by a wallet submit. */
  transactionId?: string;
}

/** Intent identity for the transaction that creates a long-lived queue request. */
export const buildEarnVaultQueuedWithdrawalFingerprint = (
  input: EarnVaultQueuedWithdrawalFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "earn_vault_queued_withdrawal_request",
      environment: input.environment,
      provider: input.provider,
      positionId: input.positionId,
      shares: normalizeDecimalString(input.shares),
      discountBps: input.discountBps,
      deadlineSeconds: input.deadlineSeconds,
      transactionId: input.transactionId ?? null,
    })
  );

export type EarnVaultParRedemptionFingerprintInput = {
  environment: string;
  provider: string;
  positionId: string;
  /** Exact unsigned build consumed by a wallet submit. */
  transactionId?: string;
} & (
  | { shares: string; intermediateAmount?: undefined }
  | { intermediateAmount: string; shares?: undefined }
);

/** Intent identity for an operator-completed par-redemption request. */
export const buildEarnVaultParRedemptionFingerprint = (
  input: EarnVaultParRedemptionFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "earn_vault_par_redemption_request",
      environment: input.environment,
      provider: input.provider,
      positionId: input.positionId,
      // Exactly one is set; the absent key drops out, so a shares-sourced
      // fingerprint stays byte-identical to the one recorded before wYLDS
      // could be redeemed directly.
      shares: input.shares === undefined ? undefined : normalizeDecimalString(input.shares),
      intermediateAmount:
        input.intermediateAmount === undefined
          ? undefined
          : normalizeDecimalString(input.intermediateAmount),
      transactionId: input.transactionId ?? null,
    })
  );

export interface EarnVaultQueuedWithdrawalCancelFingerprintInput {
  environment: string;
  withdrawalRequestId: string;
  requestAddress: string;
  /** Exact unsigned build consumed by a wallet submit. */
  transactionId?: string;
}

/** Intent identity for the recovery transaction returning escrowed shares. */
export const buildEarnVaultQueuedWithdrawalCancelFingerprint = (
  input: EarnVaultQueuedWithdrawalCancelFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "earn_vault_queued_withdrawal_cancel",
      environment: input.environment,
      withdrawalRequestId: input.withdrawalRequestId,
      requestAddress: input.requestAddress,
      transactionId: input.transactionId ?? null,
    })
  );

export interface PrivateChannelDepositFingerprintInput {
  /** The connected instance the escrow deposit lands in. */
  instanceId: string;
  /** The source custody wallet (`custody_wallets.wallet_id`) that signs. */
  walletId: string;
  /** Channel address credited by the deposit. */
  recipient: string;
  mint: string;
  amount: string;
}

/**
 * Fingerprint for a Private Channels escrow deposit.
 *
 * Same inclusion test as the Earn fingerprints: every field changes WHAT MOVES.
 * `instanceId` earns its place because the same (wallet, mint, amount) sent at
 * two connected instances is two escrows on two chains, and `recipient` because
 * the credited address is the whole point of a cross-member deposit — reusing a
 * key with a different recipient must 409, not silently answer with the first
 * one. Decimal spelling is normalized without rounding, so `1` and `1.000000`
 * are one intent to the mint.
 */
export const buildPrivateChannelDepositFingerprint = (
  input: PrivateChannelDepositFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "private_channel_deposit",
      instanceId: input.instanceId,
      walletId: input.walletId,
      recipient: input.recipient,
      mint: input.mint,
      direction: "deposit",
      amount: normalizeDecimalString(input.amount),
    })
  );

export interface PrivateChannelWithdrawalFingerprintInput {
  instanceId: string;
  /** The custody wallet whose channel balance is burned. */
  walletId: string;
  /** Address that receives the operator's release. */
  destination: string;
  mint: string;
  amount: string;
}

/**
 * Fingerprint for a Private Channels withdrawal (a burn plus a later release).
 *
 * `destination` is load-bearing here in a way it is not on a deposit: the burn
 * is irreversible and the release is what a human later pays out, so a key
 * reused with a different destination is a redirect attempt and must 409.
 */
export const buildPrivateChannelWithdrawalFingerprint = (
  input: PrivateChannelWithdrawalFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "private_channel_withdrawal",
      instanceId: input.instanceId,
      walletId: input.walletId,
      destination: input.destination,
      mint: input.mint,
      direction: "withdrawal",
      amount: normalizeDecimalString(input.amount),
    })
  );

export interface PrivateChannelTransferFingerprintInput {
  instanceId: string;
  /** The logical channel the transfer is made in. */
  channelId: string;
  /** The sending custody wallet. */
  walletId: string;
  /** `private_channel_verified_wallets.id` of the recipient. */
  recipientVerifiedWalletId: string;
  mint: string;
  amount: string;
}

/**
 * Fingerprint for a member-to-member channel transfer.
 *
 * The recipient is named by its VERIFIED-WALLET id rather than its pubkey,
 * because that id is what the request carried and what the access seam
 * authorized: a key reused against a different verified wallet is a different
 * authorization decision even when the two rows happen to share a pubkey.
 */
export const buildPrivateChannelTransferFingerprint = (
  input: PrivateChannelTransferFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "private_channel_transfer",
      instanceId: input.instanceId,
      channelId: input.channelId,
      walletId: input.walletId,
      recipientVerifiedWalletId: input.recipientVerifiedWalletId,
      mint: input.mint,
      direction: "transfer",
      amount: normalizeDecimalString(input.amount),
    })
  );
