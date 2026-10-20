import type { MovementId } from "@sdp/types/movements";
import { getDb } from "@/db/client";
import { type ApiKeyContext, authMayPerform } from "@/lib/auth";
import {
  AppError,
  conflict,
  missingAction,
  providerUnavailable,
  walletNotFound,
} from "@/lib/errors";
import { assertCallerWalletInScope } from "@/lib/money-admission";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

export function listPrivateChannelCustodyWallets(
  env: Env,
  organizationId: string,
  projectId: string
) {
  return new CustodyRuntimeTargets(getDb(env), env, new Map()).listWallets({
    organizationId,
    projectId,
  });
}

export async function resolvePrivateChannelCustodyWallet(
  env: Env,
  auth: ApiKeyContext,
  projectId: string,
  selector: string,
  wallets?: CustodyWallet[],
  allowAddress = false
): Promise<CustodyWallet> {
  if (!authMayPerform(auth, "private_channels.execute")) {
    throw missingAction("private_channels.execute");
  }
  const candidates =
    wallets ?? (await listPrivateChannelCustodyWallets(env, auth.organizationId, projectId));
  const matches = candidates.filter(
    (wallet) => wallet.walletId === selector || (allowAddress && wallet.publicKey === selector)
  );
  if (matches.length > 1) throw conflict("Custody wallet ownership is ambiguous");
  const wallet = matches[0];
  if (!wallet) throw walletNotFound();

  // Retained records must not silently disappear into an active replacement.
  const owned = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).findOwnedWalletForMutation({
    organizationId: auth.organizationId,
    projectId,
    walletId: selector,
    publicKey: allowAddress ? selector : undefined,
  });
  if (owned?.id !== wallet.id) throw conflict("Custody wallet ownership is ambiguous");
  // The custody signer refuses a wallet outside the key's scope for every
  // movement, withdrawals included (HOO-2099); refusing here as well stops the
  // flow before it records a movement or calls the gateway.
  assertCallerWalletInScope(auth, wallet.id);
  return wallet;
}

/** Admit and prepare the same exact wallet before a new SPC session or intent. */
export async function createPrivateChannelSigner(
  env: Env,
  organizationId: string,
  projectId: string,
  wallet: CustodyWallet,
  movement: MovementId
) {
  await createSigningService(env).admitRuntimeExecution(organizationId, projectId, wallet.id);
  try {
    return await createOrgSignerForCustodyWallet(
      env,
      organizationId,
      projectId,
      wallet.id,
      movement
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerUnavailable("The source custody wallet is not currently signable.");
  }
}
