import { assertApiKeyWalletAccess } from "@/lib/api-key-wallet-auth";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { createSigningService } from "@/services/domain/signing.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Permission } from "@sdp/types";
import type { AppContext } from "./context";

export async function resolveScope(c: AppContext) {
  const auth = getAuth(c);
  const signingService = createSigningService(c.env);
  const config = await signingService.getConfiguration(
    auth.organizationId,
    auth.projectId ?? undefined
  );

  if (!config) {
    throw new AppError("NOT_FOUND", "Custody configuration is not initialized for this scope");
  }

  const wallets = await signingService.getWallets(auth.organizationId, auth.projectId ?? undefined);

  return {
    auth,
    wallets,
  };
}

export type ResolvedScope = Awaited<ReturnType<typeof resolveScope>>;

export function resolveWallet(wallets: CustodyWallet[], walletId: string): CustodyWallet {
  const wallet = wallets.find((entry) => entry.walletId === walletId);
  if (!wallet) {
    throw new AppError(
      "NOT_FOUND",
      "Wallet not found. Provision wallets through /v1/custody/wallets"
    );
  }
  return wallet;
}

export function resolveWalletAddress(
  wallets: CustodyWallet[],
  walletIdOrAddress: string,
  fieldName: string,
  auth?: ReturnType<typeof getAuth>,
  requiredWalletPermissions: Permission[] = []
): string {
  const matchingWallet = wallets.find((entry) => entry.walletId === walletIdOrAddress);
  if (matchingWallet) {
    if (auth) {
      assertApiKeyWalletAccess(auth, matchingWallet.walletId, requiredWalletPermissions);
    }
    return matchingWallet.publicKey;
  }
  return assertValidAddress(walletIdOrAddress, fieldName);
}
