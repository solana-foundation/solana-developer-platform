import { RAMP_DELIVERY_MISMATCH_REASONS, type RampDeliveryMismatch } from "@sdp/types/payments";
import { z } from "zod";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";

/** What a provider reported when it settled a ramp, as `provider_data.providerSettlement` stores it. */
export const providerSettlementSchema = z
  .object({
    reference: z.string(),
    observedAt: z.string().optional(),
    onchain: z
      .object({
        signature: z.string(),
        sourceAddress: z.string().optional(),
        destinationAddress: z.string().optional(),
        amount: z.string().optional(),
      })
      .passthrough()
      .optional(),
    receivedAmount: z.string().optional(),
    receivedCurrency: z.string().optional(),
    refundAddress: z.string().optional(),
  })
  .passthrough();
export type ProviderSettlement = z.infer<typeof providerSettlementSchema>;

/**
 * The settlement the provider reported for the transfer's current reference. A
 * report bound to an earlier provider transaction is not this transfer's.
 */
export function currentProviderSettlement(
  transfer: Pick<PaymentTransferRow, "provider_data" | "provider_reference">
): ProviderSettlement | null {
  const parsed = providerSettlementSchema.safeParse(transfer.provider_data.providerSettlement);
  return parsed.success && parsed.data.reference === transfer.provider_reference
    ? parsed.data
    : null;
}

/** A delivery hold as `provider_data.deliveryMismatch` stores it; the verifier is its only writer. */
const deliveryMismatchSchema = z.object({
  reason: z.enum(RAMP_DELIVERY_MISMATCH_REASONS),
  checkedAt: z.string(),
  reportedAmount: z.string().optional(),
  observedAmount: z.string().optional(),
});

/** The delivery hold a ramp row carries, or undefined while none holds it. */
export function readDeliveryMismatch(
  providerData: PaymentTransferRow["provider_data"]
): RampDeliveryMismatch | undefined {
  const parsed = deliveryMismatchSchema.safeParse(providerData.deliveryMismatch);
  return parsed.success ? parsed.data : undefined;
}
