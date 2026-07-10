import { badRequest } from "@sdp/payments/errors";
import { isAddress } from "@sdp/solana/address";
import type { Permission } from "@sdp/types";
import { getAuth } from "@/lib/auth";
import { walletNotFound } from "@/lib/errors";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { createSigningService } from "@/services/domain/signing.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "./context";

export async function resolveScope(c: AppContext) {
  const auth = getAuth(c);
  const signingService = createSigningService(c.env);
  const wallets = await signingService.getWalletsWithProviders(
    auth.organizationId,
    auth.projectId ?? undefined,
    {
      includeAllProviders: true,
    }
  );

  return {
    auth,
    wallets,
  };
}

export type ResolvedScope = Awaited<ReturnType<typeof resolveScope>>;

export function resolveWallet(wallets: CustodyWallet[], walletId: string): CustodyWallet {
  const wallet = wallets.find((entry) => entry.walletId === walletId);
  if (!wallet) {
    throw walletNotFound();
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
  const matchingWallet = wallets.find(
    (entry) => entry.walletId === walletIdOrAddress || entry.publicKey === walletIdOrAddress
  );
  if (matchingWallet) {
    if (auth) {
      assertApiKeyWalletAccess(auth, matchingWallet.walletId, requiredWalletPermissions);
    }
    return matchingWallet.publicKey;
  }
  if (!isAddress(walletIdOrAddress)) {
    throw badRequest(
      `${fieldName} must be a \`walletId\` returned by GET /v1/wallets or a valid Solana address, got: ${walletIdOrAddress}`
    );
  }
  return walletIdOrAddress;
}
