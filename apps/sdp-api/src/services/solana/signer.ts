import type { TransactionSigner } from "@solana/kit";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

/**
 * Resolve the signer for one already-authorized custody-wallet database row. Every custody
 * signing path passes through `SigningService.getTransactionSignerForWalletRecord`, which refuses
 * a wallet outside the open cluster scope before any provider call.
 *
 * @param env - API process environment.
 * @param orgId - The organization that owns the wallet's project.
 * @param projectId - The project the wallet belongs to.
 * @param custodyWalletId - The custody-wallet database row ID.
 * @returns The wallet's transaction signer, on the scope's cluster.
 * @throws SigningError `WALLET_NOT_FOUND` when the wallet's project is outside the open scope.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
export async function createOrgSignerForCustodyWallet(
  env: Env,
  orgId: string,
  projectId: string,
  custodyWalletId: string
): Promise<TransactionSigner> {
  return createSigningService(env).getTransactionSignerForWalletRecord(
    orgId,
    projectId,
    custodyWalletId
  );
}
