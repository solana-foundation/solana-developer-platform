import { z } from "zod";

export const EARN_PROVIDER_REDEMPTION_MODES = ["standard", "instant"] as const;
export type EarnProviderRedemptionMode = (typeof EARN_PROVIDER_REDEMPTION_MODES)[number];
/** Recorded only after a provider-correlated destination transaction is verified at finality. */
export const earnProviderSettlementSchema = z.object({
  outcome: z.enum(["delivered", "cancelled"]),
  sourceSignature: z.string().min(1),
  destinationSignature: z.string().min(1),
  ownerAddress: z.string().min(1),
  providerReference: z.string().min(1),
  tokenMint: z.string().min(1),
  amount: z.string().regex(/^\d+(?:\.\d+)?$/),
  observedSlot: z.string().regex(/^\d+$/),
});
export type EarnProviderSettlement = z.infer<typeof earnProviderSettlementSchema>;

export function providerSettlementFromData(
  data: Record<string, unknown>
): EarnProviderSettlement | null {
  const result = earnProviderSettlementSchema.safeParse(data.providerSettlement);
  return result.success ? result.data : null;
}
