import type { TransactionSigner } from "@solana/kit";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

/**
 * Create a transaction signer for an organization with custody runtime-target resolution.
 *
 * Resolution order:
 * 1. Enabled Project Connection target (if selected)
 * 2. Retained Project Config
 * 3. Organization Config fallback
 *
 * This is the recommended signer factory for production use. It enables
 * per-organization signing keys with explicit DB-backed provider selection.
 *
 * @param env - API process environment
 * @param orgId - Organization ID from auth context
 * @param projectId - Optional project ID for project-specific signing keys
 * @returns TransactionSigner compatible with @solana/kit
 */
export async function createOrgSigner(
  env: Env,
  orgId: string,
  projectId?: string | null,
  walletId?: string | null
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSigner(orgId, projectId ?? undefined, walletId ?? undefined);
}

/** Resolve the signer for one already-authorized custody-wallet database row. */
export async function createOrgSignerForCustodyWallet(
  env: Env,
  orgId: string,
  projectId: string | null | undefined,
  custodyWalletId: string
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSignerForWalletRecord(
    orgId,
    projectId ?? undefined,
    custodyWalletId
  );
}
