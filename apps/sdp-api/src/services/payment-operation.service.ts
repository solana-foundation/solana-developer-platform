import { getSolanaConfig, type RpcEnv } from "@sdp/rpc";
import { assertValidAddress } from "@sdp/solana/address";
import { isDecimalString } from "@sdp/solana/amount";
import { isWellKnownTokenSymbol, type Permission, SOL_MINT, wellKnownMint } from "@sdp/types";
import { type Address, getI64Encoder, getU64Encoder } from "@solana/kit";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequest, walletNotFound } from "@/lib/errors";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";

export { SOL_MINT };

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
 * Maps native SOL aliases to "SOL" and well-known token symbols to the
 * configured cluster's mint; anything else passes through as a mint address.
 */
export function normalizePaymentToken(token: string, env: RpcEnv): string {
  if (isNativePaymentToken(token)) {
    return "SOL";
  }

  const symbol = token.trim();
  if (!isWellKnownTokenSymbol(symbol)) {
    return token;
  }

  const cluster = getSolanaConfig(env).network;
  const mint = wellKnownMint(symbol, cluster);
  if (!mint) {
    throw badRequest(`${symbol} is not available on ${cluster}`);
  }
  return mint;
}

export function resolvePaymentWallet(wallets: CustodyWallet[], walletId: string): CustodyWallet {
  const wallet = wallets.find((entry) => entry.walletId === walletId);
  if (!wallet) {
    throw walletNotFound();
  }
  return wallet;
}

export function resolveOutboundPaymentOperation(input: {
  auth: ApiKeyContext;
  wallets: CustodyWallet[];
  source: string;
  destination: string;
  token: string;
  amount: string;
  env: RpcEnv;
  requiredWalletPermissions?: Permission[];
}): OutboundPaymentOperation {
  const amount = assertPositivePaymentAmount(input.amount);

  const sourceWallet = resolvePaymentWallet(input.wallets, input.source);
  assertApiKeyWalletAccess(
    input.auth,
    sourceWallet.walletId,
    input.requiredWalletPermissions ?? []
  );

  return {
    sourceWallet,
    sourceAddress: assertValidAddress(sourceWallet.publicKey, "source"),
    destinationAddress: assertValidAddress(input.destination, "destination"),
    token: normalizePaymentToken(input.token, input.env),
    amount,
  };
}
