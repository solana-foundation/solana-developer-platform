import type { MovementOf } from "@sdp/types/movements";
import { isAddress } from "@solana/addresses";
import { getDb } from "@/db/client";
import { type ApiKeyContext, authMayPerform } from "@/lib/auth";
import {
  AppError,
  badRequest,
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
  wallets?: CustodyWallet[]
): Promise<CustodyWallet> {
  if (!authMayPerform(auth, "private_channels.execute")) {
    throw missingAction("private_channels.execute");
  }
  const candidates =
    wallets ?? (await listPrivateChannelCustodyWallets(env, auth.organizationId, projectId));
  const wallet = candidates.find((candidate) => candidate.id === selector);
  if (!wallet) throw walletNotFound();

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
  movement: MovementOf<"private_channels">
) {
  await createSigningService(env).admitRuntimeExecution(organizationId, projectId, wallet.id);
  try {
    return await createOrgSignerForCustodyWallet<"private_channels">(
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

/** Resolve Q7 address fields without accepting a provider wallet reference. */
export function resolvePrivateChannelWalletAddress(
  wallets: CustodyWallet[],
  value: string,
  fieldName: string
): string {
  const wallet = wallets.find((candidate) => candidate.id === value);
  if (wallet) return wallet.publicKey;
  if (!isAddress(value)) {
    throw badRequest(`${fieldName} must be an internal SDP wallet ID or a valid Solana address`);
  }
  return value;
}
