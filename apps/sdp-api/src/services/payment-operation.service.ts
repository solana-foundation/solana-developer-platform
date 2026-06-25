import { type Permission, SOL_MINT } from "@sdp/types";
import type { Address } from "@solana/kit";
import { isDecimalString } from "@/lib/amount";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
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

export function isNativePaymentToken(token: string): boolean {
  const normalized = token.trim();
  return normalized.toUpperCase() === "SOL" || normalized === SOL_MINT;
}

export function normalizePaymentToken(token: string): string {
  return isNativePaymentToken(token) ? "SOL" : token;
}

export function resolvePaymentWallet(wallets: CustodyWallet[], walletId: string): CustodyWallet {
  const wallet = wallets.find((entry) => entry.walletId === walletId);
  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found. Provision wallets through /v1/wallets");
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
    token: normalizePaymentToken(input.token),
    amount,
  };
}
