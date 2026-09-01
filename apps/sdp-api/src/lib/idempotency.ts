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

export async function resolveIdentityBoundIdempotencyReplay<
  Row extends { idempotency_fingerprint: string | null },
>(
  findExisting: () => Promise<Row | null>,
  fingerprint: string,
  legacyFingerprint: string,
  identityMatches: (row: Row) => boolean
): Promise<Row | null> {
  const existing = await findExisting();
  if (!existing || existing.idempotency_fingerprint === null) {
    return null;
  }
  if (
    identityMatches(existing) &&
    (existing.idempotency_fingerprint === fingerprint ||
      existing.idempotency_fingerprint === legacyFingerprint)
  ) {
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
  custodyWalletId: string;
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
  sourceCustodyWalletId: string;
  sourceAddress: string;
  token: string;
  recipients: TransferBatchFingerprintRecipientInput[];
  options: Record<string, unknown> | undefined;
}

function paymentTransferFingerprint(
  input: PaymentTransferFingerprintInput,
  custodyWalletId?: string
): string {
  return JSON.stringify(
    normalizeForFingerprint({
      scope: "payment_transfer",
      custodyWalletId,
      sourceAddress: input.sourceAddress,
      destinationAddress: input.destinationAddress,
      token: input.token,
      amount: input.amount,
      memo: input.memo ?? null,
      type: input.type,
      privateTransfer: input.privateTransfer ?? null,
    })
  );
}

export const buildPaymentTransferFingerprint = (input: PaymentTransferFingerprintInput): string =>
  paymentTransferFingerprint(input, input.custodyWalletId);

export const buildLegacyPaymentTransferFingerprint = (
  input: PaymentTransferFingerprintInput
): string => paymentTransferFingerprint(input);

function transferBatchFingerprint(
  input: TransferBatchFingerprintInput,
  sourceCustodyWalletId?: string
): string {
  return JSON.stringify(
    normalizeForFingerprint({
      scope: "payment_transfer_batch",
      sourceCustodyWalletId,
      sourceAddress: input.sourceAddress,
      token: input.token,
      recipients: input.recipients,
      options: input.options ?? null,
    })
  );
}

export const buildTransferBatchFingerprint = (input: TransferBatchFingerprintInput): string =>
  transferBatchFingerprint(input, input.sourceCustodyWalletId);

export const buildLegacyTransferBatchFingerprint = (input: TransferBatchFingerprintInput): string =>
  transferBatchFingerprint(input);

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
  /**
   * Swap-funded deposits only (both fields together, or neither): the funding
   * mint changes WHAT MOVES out of the wallet, and the swap tolerance changes
   * the deposit the transaction encodes. Deliberately optional rather than
   * null-defaulted so every fingerprint recorded before swaps existed keeps
   * matching byte-for-byte.
   */
  swapSourceTokenMint?: string;
  swapSlippageBps?: number;
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
      ...(input.swapSourceTokenMint === undefined
        ? {}
        : {
            swapSourceTokenMint: input.swapSourceTokenMint,
            swapSlippageBps: input.swapSlippageBps ?? null,
          }),
    })
  );

export interface EarnVaultWithdrawalFingerprintInput {
  environment: string;
  provider: string;
  /** The `earn_positions` row being exited. */
  positionId: string;
  /** Shares to redeem, decimal string in share units. */
  shares: string;
  /** Exit slippage floor, or null when the provider takes none. */
  minAmountOut: string | null;
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
 * are one intent to the share mint. `minAmountOut` earns its place the same way
 * the deposit's `minSharesOut` does: the floor is baked into the built
 * instruction, so omitting it would let a caller reuse a key with a weaker
 * floor and get a silent `replayed: true` for the original, stricter exit.
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
      minAmountOut: input.minAmountOut === null ? null : normalizeDecimalString(input.minAmountOut),
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
