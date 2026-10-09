import type { TransactionSigner } from "@solana/kit";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

/** Resolve the signer for one already-authorized custody-wallet database row. */
export async function createOrgSignerForCustodyWallet(
  env: Env,
  orgId: string,
  projectId: string,
  custodyWalletId: string
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSignerForWalletRecord(orgId, projectId, custodyWalletId);
}
