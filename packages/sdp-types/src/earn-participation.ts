import { z } from "zod";

/** Provider requirements describe the participant, never a wallet's approval. */
export const earnStrategyParticipationSchema = z
  .object({
    requiresKyc: z
      .boolean()
      .nullable()
      .describe(
        "Whether the investing participant must complete KYC. False means verified not required; null means unknown or conditional."
      ),
    requiresKyb: z
      .boolean()
      .nullable()
      .describe(
        "Whether the investing business must complete KYB. False means verified not required; null means unknown or conditional."
      ),
    geographicallyRestricted: z
      .boolean()
      .nullable()
      .describe(
        "Whether provider terms restrict participation by geography. This does not mean SDP enforces IP geofencing; null means unknown or conditional."
      ),
    termsUrl: z
      .url({ protocol: /^https$/ })
      .nullable()
      .describe("Provider or strategy terms and conditions URL; null when unverified."),
  })
  .strict();

/** Resolved informational requirements, independent of live deposit admission. */
export type EarnStrategyParticipation = z.infer<typeof earnStrategyParticipationSchema>;

/** Strategy facts override provider defaults; omitted fields inherit them. */
export const earnStrategyParticipationOverridesSchema = earnStrategyParticipationSchema.partial();

/** Explicit null clears a known default; false never becomes unknown. */
export type EarnStrategyParticipationOverrides = z.infer<
  typeof earnStrategyParticipationOverridesSchema
>;

/** Unknown requirements must never imply unrestricted or unverified access. */
export const UNKNOWN_EARN_STRATEGY_PARTICIPATION = {
  requiresKyc: null,
  requiresKyb: null,
  geographicallyRestricted: null,
  termsUrl: null,
} as const satisfies EarnStrategyParticipation;
