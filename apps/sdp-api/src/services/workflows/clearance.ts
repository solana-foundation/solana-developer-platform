import {
  createCounterpartiesRepository,
  createKycWalletsRepository,
  createWalletAssetEnrollmentsRepository,
  type KycWalletRow,
} from "@/db/repositories";
import { createTenantScope } from "@/lib/tenant-scope";
import type { Env } from "@/types/env";
import { dispatchWorkflowEvent } from "./event-bus";

// The counterparty's entity kind (individual/business) is a guard field on kyc_approved /
// kyc_rejected. Resolve it once per emit — a wallet maps to at most one counterparty — so
// rules can filter on it (e.g. "only if counterpartyKind is business"). null when the wallet
// has no counterparty or it can't be loaded, which simply fails an `eq`/`in` guard.
async function resolveCounterpartyKind(env: Env, kycWallet: KycWalletRow): Promise<string | null> {
  if (!kycWallet.counterparty_id) {
    return null;
  }
  // The wallet row's org/project are the trusted tenant identity — it was written by an
  // authenticated enrollment or a verified provider webhook, never request input.
  const scope = createTenantScope({
    organizationId: kycWallet.organization_id,
    projectId: kycWallet.project_id,
  });
  const counterparty = await createCounterpartiesRepository(env, scope).getCounterpartyById({
    counterpartyId: kycWallet.counterparty_id,
    organizationId: kycWallet.organization_id,
    projectId: kycWallet.project_id,
  });
  return counterparty?.entity_type ?? null;
}

// Identity status changes over a wallet's life: verified → rejected → verified again
// after the holder re-submits. Keying idempotency on (wallet, token) alone made that
// second verification permanently unique-constrained away, so a re-verified holder was
// never re-allowlisted. Including the status transition lets each real transition fire
// once while re-delivered webhooks for the same one stay no-ops.
function transition(wallet: KycWalletRow): string {
  // `status_changed_at` moves only when the status itself changes. `updated_at` used to
  // stand in for a rejection (no `verified_at`), but it moves on any write to the row —
  // enrolling the holder for a second asset re-upserts it — so a redelivery after an
  // unrelated write re-dated the same rejection into a fresh key and enqueued it twice.
  return wallet.status_changed_at;
}

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

  const counterpartyKind = await resolveCounterpartyKind(env, input.kycWallet);

  let dispatched = 0;
  for (const enrollment of enrollments) {
    dispatched += await dispatchWorkflowEvent(env, {
      type: "kyc_approved",
      organizationId: input.kycWallet.organization_id,
      projectId: input.kycWallet.project_id,
      eventKey: `kyc_approved:${input.kycWallet.id}:${enrollment.token_id}:${transition(input.kycWallet)}`,
      tokenId: enrollment.token_id,
      payload: {
        wallet: input.kycWallet.wallet_address,
        counterpartyId: input.kycWallet.counterparty_id,
        counterpartyKind,
        provider: input.provider ?? input.kycWallet.kyc_provider,
      },
    });
  }
  return dispatched;
}

/**
 * Emit a `kyc_rejected` workflow event for each asset a wallet is enrolled for when its
 * identity check is rejected. Mirrors the approved path (per-(wallet, token) idempotency).
 */
export async function emitKycRejectedForEnrollments(
  env: Env,
  input: { kycWallet: KycWalletRow; provider?: string | null }
): Promise<number> {
  if (input.kycWallet.kyc_status !== "rejected") {
    return 0;
  }

  const enrollments = await createWalletAssetEnrollmentsRepository(
    env
  ).listActiveEnrollmentsForWallet({ kycWalletId: input.kycWallet.id });

  const counterpartyKind = await resolveCounterpartyKind(env, input.kycWallet);

  let dispatched = 0;
  for (const enrollment of enrollments) {
    dispatched += await dispatchWorkflowEvent(env, {
      type: "kyc_rejected",
      organizationId: input.kycWallet.organization_id,
      projectId: input.kycWallet.project_id,
      eventKey: `kyc_rejected:${input.kycWallet.id}:${enrollment.token_id}:${transition(input.kycWallet)}`,
      tokenId: enrollment.token_id,
      payload: {
        wallet: input.kycWallet.wallet_address,
        counterpartyId: input.kycWallet.counterparty_id,
        counterpartyKind,
        provider: input.provider ?? input.kycWallet.kyc_provider,
      },
    });
  }
  return dispatched;
}
