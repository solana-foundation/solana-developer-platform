import {
  createKycWalletsRepository,
  createWalletAssetEnrollmentsRepository,
  type KycWalletRow,
} from "@/db/repositories";
import type { Env } from "@/types/env";
import { dispatchWorkflowEvent } from "./event-bus";

// "Cleared to hold this asset" = identity verified AND an active enrollment exists.
// In v1 the enrollment stands in for eligibility; the fast-follow adds concrete
// jurisdiction/accreditation checks HERE — one function, no engine change.
export interface HolderClearance {
  cleared: boolean;
  reasons: string[];
}

export async function evaluateHolderClearance(
  env: Env,
  params: { kycWalletId: string; tokenId: string; organizationId: string; projectId: string }
): Promise<HolderClearance> {
  const reasons: string[] = [];

  const wallet = await createKycWalletsRepository(env).getKycWalletById({
    kycWalletId: params.kycWalletId,
    organizationId: params.organizationId,
    projectId: params.projectId,
  });
  if (wallet?.kyc_status !== "verified") {
    reasons.push("kyc_not_verified");
  }

  const enrollment = await createWalletAssetEnrollmentsRepository(env).getActiveEnrollment({
    kycWalletId: params.kycWalletId,
    tokenId: params.tokenId,
  });
  if (!enrollment) {
    reasons.push("not_enrolled");
  }

  return { cleared: reasons.length === 0, reasons };
}

/**
 * Emit a `kyc_approved` workflow event for every asset a wallet is *cleared* for.
 * Called from both write paths — when KYC verifies, and when an enrollment is created
 * for an already-verified wallet — so the event fires on the false→true transition
 * whichever side flips last. The per-(wallet, token) idempotency key dedupes across both.
 */
export async function emitKycApprovedForClearedEnrollments(
  env: Env,
  input: { kycWallet: KycWalletRow; provider?: string | null }
): Promise<number> {
  if (input.kycWallet.kyc_status !== "verified") {
    return 0;
  }

  const enrollments = await createWalletAssetEnrollmentsRepository(
    env
  ).listActiveEnrollmentsForWallet({ kycWalletId: input.kycWallet.id });

  let dispatched = 0;
  for (const enrollment of enrollments) {
    dispatched += await dispatchWorkflowEvent(env, {
      type: "kyc_approved",
      organizationId: input.kycWallet.organization_id,
      projectId: input.kycWallet.project_id,
      eventKey: `kyc_approved:${input.kycWallet.id}:${enrollment.token_id}`,
      tokenId: enrollment.token_id,
      payload: {
        wallet: input.kycWallet.wallet_address,
        counterpartyId: input.kycWallet.counterparty_id,
        provider: input.provider ?? input.kycWallet.kyc_provider,
      },
    });
  }
  return dispatched;
}
