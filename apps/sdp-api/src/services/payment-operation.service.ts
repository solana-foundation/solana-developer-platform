import { currentClusterScope } from "@sdp/rpc/scope";
import { assertValidAddress } from "@sdp/solana/address";
import { isDecimalString } from "@sdp/solana/amount";
import {
  type CryptoRailId,
  getCryptoRailAssetLabel,
  isWellKnownTokenSymbol,
  SOL_MINT,
  WELL_KNOWN_TOKEN_BY_MINT,
  wellKnownMint,
} from "@sdp/types";
import { type Address, getI64Encoder, getU64Encoder } from "@solana/kit";
import { AppError, badRequest, walletNotFound } from "@/lib/errors";
import type { CustodyWallet } from "@/services/stores/custody-config.store";

export interface OutboundPaymentOperation {
  sourceWallet: CustodyWallet;
  sourceAddress: Address;
  destinationAddress: Address;
  token: string;
  amount: string;
}

export function assertPaymentProjectScope(
  bodyProjectId: string | undefined,
  authProjectId: string | null
): void {
  if (!bodyProjectId) {
    return;
  }

  if (!authProjectId) {
    throw new AppError(
      "BAD_REQUEST",
      "projectId overrides are not supported for org-scoped keys in payments endpoints"
    );
  }

  if (bodyProjectId !== authProjectId) {
    throw badRequest("projectId does not match the authenticated API key scope");
  }
}

export function assertPositivePaymentAmount(amount: string): string {
  const normalized = amount.trim();

  if (!isDecimalString(normalized)) {
    throw badRequest("Invalid amount format");
  }

  // isDecimalString guarantees only digits and "." are present, so any non-zero digit
  // proves the decimal value is positive without converting to a floating point number.
  for (const char of normalized) {
    if (char !== "." && char !== "0") {
      return normalized;
    }
  }

  throw badRequest("Transfer amount must be greater than zero");
}

/**
 * Parses a numeric string into a bigint, rejecting values outside the unsigned
 * 64-bit range via the canonical u64 codec.
 */
export function parseU64String(value: string, fieldName: string): bigint {
  try {
    const parsed = BigInt(value);
    getU64Encoder().encode(parsed);
    return parsed;
  } catch {
    throw badRequest(`${fieldName} must fit in an unsigned 64-bit integer`);
  }
}

/**
 * Parses a numeric string into a bigint, rejecting values outside the signed
 * 64-bit range via the canonical i64 codec.
 */
export function parseI64String(value: string, fieldName: string): bigint {
  try {
    const parsed = BigInt(value);
    getI64Encoder().encode(parsed);
    return parsed;
  } catch {
    throw badRequest(`${fieldName} must fit in a signed 64-bit integer`);
  }
}

export function isNativePaymentToken(token: string): boolean {
  const normalized = token.trim();
  return normalized.toUpperCase() === "SOL" || normalized === SOL_MINT;
}

/**
 * Maps native SOL aliases and well-known token symbols (case-insensitive) to
 * the open scope's cluster mint. A well-known mint address must be deployed on
 * that cluster; any other mint passes through byte-exact, since base58 is
 * case-sensitive. Native SOL canonicalizes to the
 * wrapped SOL mint so `token` values compare uniformly — dispatch between
 * native and SPL paths goes through {@link isNativePaymentToken}, never string
 * equality against the mint.
 *
 * @param token - A native SOL alias, a well-known token symbol, or a mint address.
 * @returns The canonical mint address for `token` on the scope's cluster.
 * @throws AppError (400) when a well-known symbol has no mint on that cluster, or a
 * well-known mint address belongs only to the other cluster.
 */
export function normalizePaymentToken(token: string): string {
  if (isNativePaymentToken(token)) {
    return SOL_MINT;
  }

  const { cluster } = currentClusterScope();
  const symbol = token.trim().toUpperCase();
  if (!isWellKnownTokenSymbol(symbol)) {
    const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(token);
    if (wellKnown && !wellKnown.clusters.includes(cluster)) {
      throw badRequest(`${wellKnown.symbol} mint ${token} is not available on ${cluster}`);
    }
    return token;
  }

  const mint = wellKnownMint(symbol, cluster);
  if (!mint) {
    throw badRequest(`${symbol} is not available on ${cluster}`);
  }
  return mint;
}

/**
 * Resolves a quoted ramp asset rail to the mint recorded on the transfer
 * row, keeping ramp rows on the same token-is-a-mint contract as every other
 * transfer. Ramp rails only quote well-known symbols, so an unresolvable
 * transfer. The canonical rail is mapped to its well-known asset symbol at
 * this boundary; unavailable cluster mints fail loudly.
 *
 * @param assetRail - The canonical quoted crypto rail, e.g. "usdc.solana".
 * @returns The mint address on the open scope's cluster, the one `/transfers` resolves funding tokens on.
 * @throws AppError (400) when the rail's asset has no mint on that cluster.
 */
export function rampTransferTokenMint(assetRail: CryptoRailId): string {
  const symbol = getCryptoRailAssetLabel(assetRail);
  const { cluster } = currentClusterScope();
  const mint = wellKnownMint(symbol, cluster);
  if (!mint) {
    throw badRequest(`${symbol} is not available on ${cluster}`);
  }
  return mint;
}

export function resolvePaymentWallet(
  wallets: CustodyWallet[],
  custodyWalletId: string
): CustodyWallet {
  const wallet = wallets.find((entry) => entry.id === custodyWalletId);
  if (!wallet) {
    throw walletNotFound();
  }
  return wallet;
}

export function resolveOutboundPaymentOperation(input: {
  wallets: CustodyWallet[];
  sourceCustodyWalletId: string;
  destination: string;
  token: string;
  amount: string;
}): OutboundPaymentOperation {
  const amount = assertPositivePaymentAmount(input.amount);

  // The caller checks the credential's access to the wallet, read fresh.
  const sourceWallet = resolvePaymentWallet(input.wallets, input.sourceCustodyWalletId);

  return {
    sourceWallet,
    sourceAddress: assertValidAddress(sourceWallet.publicKey, "source"),
    destinationAddress: assertValidAddress(input.destination, "destination"),
    token: normalizePaymentToken(input.token),
    amount,
  };
}
