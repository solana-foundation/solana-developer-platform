import { getDb } from "@/db/client";
import type { ApiKeyContext } from "@/lib/auth";
import { walletNotFound } from "@/lib/errors";
import type { AppContext } from "@/routes/earn/context";
import {
  CustodyRuntimeTargets,
  type CustodyRuntimeWalletProjection,
} from "@/services/domain/signing/custody-runtime-target";

/** Resolve only the exact persisted custody wallet identity. */
export function resolveEarnCustodyWallet(
  wallets: readonly CustodyRuntimeWalletProjection[],
  custodyWalletId: string
): CustodyRuntimeWalletProjection {
  const exact = wallets.find((wallet) => wallet.id === custodyWalletId);
  if (exact) return exact;
  throw walletNotFound();
}

/**
 * The custody wallets an Earn read may see: every wallet of the project
 * (HOO-2099). Only the wallet list and wallet detail reads narrow to a
 * selected key's list; spending from a wallet is decided by the custody
 * signer. Shared by every Earn custody-position read.
 */
export async function listReadableEarnWallets(
  c: AppContext,
  auth: ApiKeyContext,
  projectId: string
): Promise<CustodyRuntimeWalletProjection[]> {
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: auth.organizationId,
    projectId,
  });

  return wallets;
}
