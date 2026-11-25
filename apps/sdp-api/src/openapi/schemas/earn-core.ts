import { earnBalanceReadContextSchema } from "@sdp/types/earn-wire";
import { operationSourceSchema } from "@sdp/types/operations";
import { z } from "zod";
import { successResponseSchema } from "./base";
import {
  earnStrategiesResponse,
  earnWalletPositionSchema,
  earnWalletPositionSummaryResponse,
} from "./earn";

const strategySchema = earnStrategiesResponse.shape.data.shape.strategies.element;
const nullableDate = z.string().datetime().nullable();

/** Discovery exposes one strategy catalogue with explicit rates and capabilities. */
export const earnDiscoveryResponseSchema = successResponseSchema(
  earnStrategiesResponse.shape.data.extend({
    strategies: z.array(
      strategySchema.extend({
        rate: z.object({
          value: z.string().nullable(),
          measure: z.literal("apy"),
          basis: z.literal("provider_reported"),
          observedAt: nullableDate.openapi({
            description:
              "Rate observation time; null when the provider observation time is unknown.",
          }),
          source: z.object({ provider: z.string(), providerReference: z.string() }),
        }),
        capabilities: z.object({
          deposit: z.boolean(),
          withdraw: z.boolean(),
          admission: z.literal("evaluated_on_prepare"),
          depositUnavailableReason: z.enum(["catalogue_only", "adapter_unavailable"]).optional(),
        }),
      })
    ),
  })
);

/** Canonical position resource shared by collection and detail reads. */
export const earnCorePositionSchema = earnWalletPositionSchema.omit({ ownerAddress: true }).extend({
  feeSponsored: z.boolean(),
  source: operationSourceSchema,
  strategyId: z.string().optional(),
  createdAt: nullableDate,
  discovered: z.boolean().optional(),
  costBasisKnown: z.boolean(),
});
/** Detail reads attach the floor needed for a paired wallet balance refresh. */
export const earnCorePositionDetailSchema = earnCorePositionSchema.extend({
  balanceReadContext: earnBalanceReadContextSchema.optional(),
});
const summarySchema = earnWalletPositionSummaryResponse.shape.data.shape.summary;
const strategyTotalSchema = summarySchema.shape.totalsByStrategy.element;
const coreSummarySchema = summarySchema.extend({
  costBasisCoverage: z.enum(["complete", "unknown"]),
  unknownCostBasisPositionCount: z.number().int().nonnegative(),
  totalsByStrategy: z.array(
    strategyTotalSchema.extend({
      positions: z
        .array(
          earnWalletPositionSchema.extend({
            createdAt: nullableDate,
            discovered: z.boolean().optional(),
          })
        )
        .optional(),
    })
  ),
});

/** Scope totals include the complete selected scope, not just the current position page. */
export const earnPositionsResponseSchema = successResponseSchema(
  z.object({
    positions: z.array(earnCorePositionSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    balanceReadContext: earnBalanceReadContextSchema.optional(),
    summary: coreSummarySchema.optional(),
    coverage: z.enum(["sdp_tracked_positions", "integrated_catalogue_positions"]),
    discovery: z
      .object({
        strategyCount: z.number().int().nonnegative(),
        unavailableStrategyCount: z.number().int().nonnegative(),
      })
      .optional(),
  })
);
