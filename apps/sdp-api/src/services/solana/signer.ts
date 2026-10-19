import type { MovementId } from "@sdp/types/movements";
import type { TransactionSigner } from "@solana/kit";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

/**
 * Resolve the signer for one already-authorized custody-wallet database row,
 * for the movement it serves. A start the organization may not make right now
 * (deleted, suspended, or production without the entitlement) gets a signer
 * that refuses to sign (HOO-1955); so does any movement, exits included, that
 * the ambient credential may not make with this wallet (HOO-2099).
 */
export async function createOrgSignerForCustodyWallet(
  env: Env,
  orgId: string,
  projectId: string,
  custodyWalletId: string,
  movement: MovementId
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSignerForWalletRecord(
    orgId,
    projectId,
    custodyWalletId,
    movement
  );
}
