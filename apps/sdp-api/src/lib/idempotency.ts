import { createHash } from "node:crypto";
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

export interface EarnVaultDepositFingerprintInput {
  environment: string;
  provider: string;
  /** The vault address. */
  providerReference: string;
  /** The `custody_wallets` row id that signs and holds the shares. */
  custodyWalletId: string;
  amount: string;
  /** The slippage floor, or null when none applies. */
  minSharesOut: string | null;
}

/** Canonicalize decimal spelling without rounding or passing through a float. */
function normalizeDecimalString(value: string): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction === ""
    ? normalizedInteger
    : `${normalizedInteger}.${normalizedFraction}`;
}

/**
 * Fingerprint for a non-custodial vault deposit.
 *
 * Every field here changes WHAT MOVES, which is the whole test for inclusion.
 * `minSharesOut` earns its place for a reason that is easy to miss: the floor is
 * baked into the built instruction, so omitting it would let a caller reuse a
 * key with a weaker floor — or none — and get a silent `replayed: true` for the
 * original, stricter deposit. `environment` is included because the same key
 * arriving in sandbox and in production is two requests against two chains.
 *
 * Decimal spelling is normalized without rounding. The builder accepts
 * insignificant zeroes and canonicalizes them to the same mint atoms, so `1`
 * and `1.000000` are one intent. Non-zero sub-atom precision remains distinct
 * here and is rejected by the provider builder before anything is signed.
 */
export const buildEarnVaultDepositFingerprint = (input: EarnVaultDepositFingerprintInput): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "earn_vault_deposit",
      environment: input.environment,
      provider: input.provider,
      providerReference: input.providerReference,
      custodyWalletId: input.custodyWalletId,
      direction: "deposit",
      amount: normalizeDecimalString(input.amount),
      minSharesOut: input.minSharesOut === null ? null : normalizeDecimalString(input.minSharesOut),
    })
  );

export interface EarnVaultWithdrawalFingerprintInput {
  environment: string;
  provider: string;
  /** The `earn_positions` row being exited. */
  positionId: string;
  /** Shares to redeem, decimal string in share units. */
  shares: string;
}

/**
 * Fingerprint for a non-custodial vault withdrawal.
 *
 * Same inclusion test as the deposit's: every field changes WHAT MOVES. The
 * position id carries the vault and the signing wallet transitively (a holding
 * is one (org, environment, provider, vault, wallet) claim), so naming it is
 * naming both; `environment` is included because the same key arriving in
 * sandbox and production is two requests against two chains. Decimal spelling
 * is normalized without rounding, exactly like the deposit — `1` and `1.000000`
 * are one intent to the share mint.
 */
export const buildEarnVaultWithdrawalFingerprint = (
  input: EarnVaultWithdrawalFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "earn_vault_withdrawal",
      environment: input.environment,
      provider: input.provider,
      positionId: input.positionId,
      direction: "withdrawal",
      shares: normalizeDecimalString(input.shares),
    })
  );

export interface EarnExternalWalletDepositFingerprintInput {
  environment: string;
  provider: string;
  /** The vault address. */
  providerReference: string;
  /** The external wallet that signs and holds the shares. */
  ownerAddress: string;
  amount: string;
  minSharesOut: string | null;
  /** The built transaction being submitted (`earn_external_wallet_transactions.id`). */
  transactionId: string;
}

/**
 * Fingerprint for an external-wallet (caller-signed) vault deposit submit.
 *
 * Same inclusion test as the custody deposit's: every field changes WHAT MOVES.
 * `transactionId` earns its place because the submit names one specific built
 * transaction: two builds are two distinct signable transactions, so a key
 * retried against a REBUILT transaction is a different request and must 409
 * rather than silently answer with the first build's movement.
 */
export const buildEarnExternalWalletDepositFingerprint = (
  input: EarnExternalWalletDepositFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "earn_external_wallet_deposit",
      environment: input.environment,
      provider: input.provider,
      providerReference: input.providerReference,
      ownerAddress: input.ownerAddress,
      direction: "deposit",
      amount: normalizeDecimalString(input.amount),
      minSharesOut: input.minSharesOut === null ? null : normalizeDecimalString(input.minSharesOut),
      transactionId: input.transactionId,
    })
  );

export interface EarnExternalWalletWithdrawalFingerprintInput {
  environment: string;
  provider: string;
  /** The `earn_positions` row being exited. */
  positionId: string;
  /** The external wallet whose shares redeem. */
  ownerAddress: string;
  shares: string;
  /** The built transaction being submitted (`earn_external_wallet_transactions.id`). */
  transactionId: string;
}

/** Fingerprint for an external-wallet withdrawal submit; see the deposit's note. */
export const buildEarnExternalWalletWithdrawalFingerprint = (
  input: EarnExternalWalletWithdrawalFingerprintInput
): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "earn_external_wallet_withdrawal",
      environment: input.environment,
      provider: input.provider,
      positionId: input.positionId,
      ownerAddress: input.ownerAddress,
      direction: "withdrawal",
      shares: normalizeDecimalString(input.shares),
      transactionId: input.transactionId,
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

export interface EarnWithdrawalFingerprintInput {
  providerWalletRef: string;
  amountUsd: string;
  token: string;
  destinationAddress: string;
}

export const buildEarnWithdrawalFingerprint = (input: EarnWithdrawalFingerprintInput): string =>
  JSON.stringify(
    normalizeForFingerprint({
      scope: "earn_program_withdrawal",
      providerWalletRef: input.providerWalletRef,
      // Normalized exactly as the provider wire is: portfolio clients send
      // amountUsd as a JSON number, so '100' and '100.00' are one request to
      // the provider and must be one fingerprint — SDP's conflict judgment
      // must never be stricter than the provider request it guards.
      amountUsd: String(Number(input.amountUsd)),
      token: input.token,
      destinationAddress: input.destinationAddress,
    })
  );
