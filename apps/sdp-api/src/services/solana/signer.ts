import type { TransactionSigner } from "@solana/kit";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

/**
 * Create a transaction signer for a project with custody runtime-target resolution.
 *
 * Resolution order:
 * 1. Enabled Project Connection target (if selected)
 * 2. Retained Project Config
 *
 * This is the recommended signer factory for production use. It enables
 * per-project signing keys with explicit DB-backed provider selection.
 *
 * @param env - API process environment
 * @param orgId - Organization ID from auth context
 * @param projectId - The project whose custody signs
 * @param walletId - A provider wallet ID, or the project's default wallet when omitted
 * @returns TransactionSigner compatible with @solana/kit
 */
export async function createOrgSigner(
  env: Env,
  orgId: string,
  projectId: string,
  walletId?: string | null
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSigner(orgId, projectId, walletId);
}

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
