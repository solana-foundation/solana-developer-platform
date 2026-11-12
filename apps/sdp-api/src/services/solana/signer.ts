import type { WaistMovement } from "@sdp/types/movements";
import type { SdpModule } from "@sdp/types/release-channels";
import type { TransactionSigner } from "@solana/kit";
import type {
  CustodyProposalReader,
  CustodyProposalRecovery,
  CustodyTransferProposer,
  TransferProposalIntent,
} from "@/services/domain/signing/admitted-proposer";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

/**
 * Resolve the signer for one already-authorized custody-wallet database row,
 * for the movement it serves. A start the organization may not make right now
 * (deleted, suspended, or production without the entitlement) gets a signer
 * that refuses to sign (HOO-1955); so does any movement, exits included, that
 * the ambient credential may not make with this wallet (HOO-2099). The caller
 * names its module, and only that module's movements compile (HOO-2098).
 */
export async function createOrgSignerForCustodyWallet<Module extends SdpModule = never>(
  env: Env,
  orgId: string,
  projectId: string,
  custodyWalletId: string,
  movement: WaistMovement<Module>
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSignerForWalletRecord(
    orgId,
    projectId,
    custodyWalletId,
    movement
  );
}

/**
 * The same waist for a wallet whose provider builds and sends its own transfers (a Fireblocks
 * BYOK Connection): the same prelude and the same live admission on every proposal as a
 * signature gets. Returns `null` for every wallet that signs, which then uses
 * {@link createOrgSignerForCustodyWallet} (PRO-2435 D2).
 */
export async function createOrgTransferProposerForCustodyWallet<Module extends SdpModule = never>(
  env: Env,
  orgId: string,
  projectId: string,
  custodyWalletId: string,
  movement: WaistMovement<Module>
): Promise<CustodyTransferProposer | null> {
  return createSigningService(env).getTransferProposerForWalletRecord(
    orgId,
    projectId,
    custodyWalletId,
    movement
  );
}

/** Read-only recovery for a recorded proposal, bound to its intent. It never creates a transfer. */
export async function createOrgTransferProposalReader(
  env: Env,
  orgId: string,
  projectId: string,
  custodyWalletId: string,
  binding: TransferProposalIntent & { sourceAddress: string | null }
): Promise<CustodyProposalReader> {
  return createSigningService(env).getTransferProposalReaderForWalletRecord(
    orgId,
    projectId,
    custodyWalletId,
    binding
  );
}

/**
 * Resolve recovery capabilities for trusted worker use under the recorded principal. Admission
 * is explicit so a refused movement can still request cancellation, never another submission.
 */
export async function createOrgTransferProposalRecovery<Module extends SdpModule = never>(
  env: Env,
  orgId: string,
  projectId: string,
  custodyWalletId: string,
  binding: TransferProposalIntent & { sourceAddress: string | null },
  movement: WaistMovement<Module>
): Promise<CustodyProposalRecovery> {
  return createSigningService(env).getTransferProposalRecoveryForWalletRecord(
    orgId,
    projectId,
    custodyWalletId,
    binding,
    movement
  );
}
