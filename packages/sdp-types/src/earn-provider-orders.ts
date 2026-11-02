import { z } from "zod";

export const EARN_PROVIDER_REDEMPTION_MODES = ["standard", "instant"] as const;
export type EarnProviderRedemptionMode = (typeof EARN_PROVIDER_REDEMPTION_MODES)[number];
export const EARN_PROVIDER_ACTION_KINDS = ["preparation", "cancellation"] as const;
export type EarnProviderActionKind = (typeof EARN_PROVIDER_ACTION_KINDS)[number];
export const EARN_PROVIDER_ACTION_STATUSES = [
  "preparing",
  "not_required",
  "prepared",
  "requested",
  "submitted",
  "confirmed",
  "awaiting_delivery",
  "finalized",
  "failed",
] as const;
export type EarnProviderActionStatus = (typeof EARN_PROVIDER_ACTION_STATUSES)[number];
export const EARN_PROVIDER_ACTION_TERMINAL_STATUSES = [
  "not_required",
  "finalized",
  "failed",
] as const satisfies readonly EarnProviderActionStatus[];
export const EARN_PROVIDER_ACTION_CHAIN_STATUSES = [
  "requested",
  "submitted",
  "confirmed",
] as const satisfies readonly EarnProviderActionStatus[];
export const EARN_PROVIDER_ACTION_TRANSITIONS = {
  preparing: ["prepared", "requested", "failed", "not_required"],
  not_required: [],
  prepared: ["requested"],
  requested: ["submitted", "confirmed", "awaiting_delivery", "finalized", "failed"],
  submitted: ["confirmed", "awaiting_delivery", "finalized", "failed"],
  confirmed: ["awaiting_delivery", "finalized", "failed"],
  awaiting_delivery: ["finalized", "failed"],
  finalized: [],
  failed: [],
} as const satisfies Record<EarnProviderActionStatus, readonly EarnProviderActionStatus[]>;

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

export const earnProviderActionSchema = z.object({
  actionId: z.string(),
  action: z.enum(EARN_PROVIDER_ACTION_KINDS),
  status: z.enum(EARN_PROVIDER_ACTION_STATUSES),
  provider: z.string(),
  providerReference: z.string(),
  ownerAddress: z.string(),
  feePayer: z.string().nullable(),
  parentMovementId: z.string().nullable(),
  signature: z.string().nullable(),
  deliverySignature: z.string().nullable(),
  lastValidBlockHeight: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  transaction: z.string().nullable(),
});
export type EarnProviderAction = z.infer<typeof earnProviderActionSchema>;
