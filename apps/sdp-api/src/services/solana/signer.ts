import type { TransactionSigner } from "@solana/kit";
import type { AdmittedMovement } from "@/lib/admit-movement";
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
 * @param movement - Admission for this organization, project and purpose (HOO-1955)
 * @returns TransactionSigner compatible with @solana/kit
 */
export async function createOrgSigner(
  env: Env,
  movement: AdmittedMovement,
  walletId?: string | null
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSigner(movement, walletId ?? undefined);
}

/** Resolve the signer for one already-authorized custody-wallet database row. */
export async function createOrgSignerForCustodyWallet(
  env: Env,
  movement: AdmittedMovement,
  custodyWalletId: string
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSignerForWalletRecord(movement, custodyWalletId);
}
