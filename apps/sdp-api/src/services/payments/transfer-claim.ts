import { isDefinitiveProviderRejection } from "@sdp/payments/ramps/fetch";
import type { PaymentsRepository, PaymentTransferStatus } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";

export const TRANSFER_CLAIM_KEYS = ["sandboxSimulation"] as const;
export type TransferClaimKey = (typeof TRANSFER_CLAIM_KEYS)[number];

export type TransferClaimOutcome<T> = { claimed: true; result: T } | { claimed: false };

/**
 * Runs a once-only provider call under a first-write-wins claim on
 * `provider_data[claimKey]` of a transfer. The claim is a CAS on the
 * transfer's status plus an IS NULL check on the key, so concurrent callers
 * race on the row and exactly one reaches the provider; losers spend nothing.
 *
 * The claim is kept on success and on any failure that might have reached the
 * provider (transport error, timeout, 408, 409, 5xx, unparseable 2xx, crash
 * after the claim). It is released only on a definitive provider rejection,
 * and only while the row still holds this caller's exact claim in the claimed
 * status, so the release can never undo another caller's claim or a later
 * state transition. A retained claim is never retried automatically; the
 * transfer leaving `expectedStatus` is what retires it.
 *
 * @param input.repository - Payments repository scoped to the caller's tenant.
 * @param input.transferId - The transfer to claim.
 * @param input.organizationId - Tenant scope.
 * @param input.projectId - Tenant scope.
 * @param input.expectedStatus - The status the caller validated the transfer in.
 * @param input.claimKey - Top-level provider_data key that holds the claim.
 * @param input.send - The provider call; must do no local work that can throw before the request is sent.
 * @returns The provider result when this caller won the claim, or `claimed: false` when another caller holds it or the row moved.
 */
export async function sendOnceUnderTransferClaim<T>(input: {
  repository: PaymentsRepository;
  transferId: string;
  organizationId: string;
  projectId: string;
  expectedStatus: PaymentTransferStatus;
  claimKey: TransferClaimKey;
  send: () => Promise<T>;
}): Promise<TransferClaimOutcome<T>> {
  const requestedAt = new Date().toISOString();
  const claimValue = { requestedAt };
  const claimed = await input.repository.claimTransferProviderData({
    transferId: input.transferId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    expectedStatus: input.expectedStatus,
    claimPath: [input.claimKey],
    providerData: { [input.claimKey]: claimValue },
    updatedAt: requestedAt,
  });
  if (claimed === null) {
    return { claimed: false };
  }

  try {
    return { claimed: true, result: await input.send() };
  } catch (error) {
    if (!isDefinitiveProviderRejection(error)) {
      getLogger().warn(
        {
          event: "sdp_api_transfer_claim_retained",
          transfer_id: input.transferId,
          claim_key: input.claimKey,
        },
        "Provider call failed ambiguously; claim retained so the request is never resubmitted"
      );
      throw error;
    }
    await input.repository.releaseTransferProviderDataClaim({
      transferId: input.transferId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      expectedStatus: input.expectedStatus,
      claimPath: [input.claimKey],
      claimValue,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}
