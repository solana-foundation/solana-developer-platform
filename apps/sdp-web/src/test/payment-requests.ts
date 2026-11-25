import type { PaymentRequest } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";

/** The wallet address a test payment request is paid into (valid base58). */
export const TEST_PAYMENT_REQUEST_RECIPIENT = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";

/**
 * An open SOL payment request, as the API's read returns it, with `changes` applied.
 *
 * @param changes - The fields a test sets; the rest describe an open request with no expiry.
 * @returns The request.
 */
export function testPaymentRequest(changes: Partial<PaymentRequest>): PaymentRequest {
  return {
    id: "preq_1",
    organizationId: "org_1",
    projectId: "prj_1",
    walletId: "wallet_1",
    destinationAddress: TEST_PAYMENT_REQUEST_RECIPIENT,
    token: SOL_MINT,
    amount: "5",
    reference: "ref_1",
    status: "awaiting_payment",
    expiresAt: null,
    fulfilledByTransferId: null,
    paidLate: false,
    canceledByApiKeyId: null,
    canceledByUserId: null,
    canceledAt: null,
    lifecycle: [{ status: "awaiting_payment", at: "2026-09-14T00:00:00.000Z" }],
    createdBy: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...changes,
  };
}
