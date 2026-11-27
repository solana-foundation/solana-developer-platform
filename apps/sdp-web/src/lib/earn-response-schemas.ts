import type {
  EarnCorePosition,
  EarnCorePositionSummary,
  EarnDiscoveryResponse,
  EarnPositionsResponse,
} from "@sdp/types/earn-core";
import { earnBalanceReadContextSchema } from "@sdp/types/earn-wire";
import { SOLANA_CLUSTERS } from "@sdp/types/well-known-tokens";
import { z } from "zod";

const slippage = z.object({ quoteRequired: z.literal(true), defaultToleranceBps: z.number() });
const intermediate = z.object({
  mint: z.string(),
  amount: z.string(),
  withdrawableAmount: z.string(),
  tokenValue: z.string(),
});

const positionFields = {
  id: z.string(),
  provider: z.string(),
  providerReference: z.string(),
  label: z.string(),
  tokenMint: z.string(),
  shareMint: z.string(),
  createdAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  shares: z.string().optional(),
  withdrawableShares: z.string().optional(),
  unlockTimestamp: z.string().nullable().optional(),
  tokenValue: z.string().optional(),
  parIntermediate: intermediate.optional(),
};

const tokenTotal = z.object({
  tokenMint: z.string(),
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  unavailablePositionCount: z.number().int().nonnegative(),
  tokenValue: z.string().optional(),
});

/** Explicit address opt-in preserves the existing project-summary privacy boundary. */
export const earnCoreSummarySchema: z.ZodType<EarnCorePositionSummary> = z.object({
  costBasisCoverage: z.enum(["complete", "unknown"]),
  unknownCostBasisPositionCount: z.number().int().nonnegative(),
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  unavailablePositionCount: z.number().int().nonnegative(),
  totalsByStrategy: z.array(
    z.object({
      provider: z.string(),
      providerReference: z.string(),
      label: z.string(),
      ownerAddresses: z.array(z.string()).optional(),
      positions: z.array(z.object({ ...positionFields, ownerAddress: z.string() })).optional(),
      walletCount: z.number().int().nonnegative(),
      positionCount: z.number().int().nonnegative(),
      totalsByToken: z.array(tokenTotal),
    })
  ),
  totalsByToken: z.array(tokenTotal),
});

/** Detail and list reads validate the same position without fabricating unknown values. */
export const earnCorePositionSchema: z.ZodType<EarnCorePosition> = z.looseObject({
  ...positionFields,
  source: z.union([
    z.strictObject({ walletId: z.string() }),
    z.strictObject({ ownerAddress: z.string() }),
  ]),
  strategyId: z.string().optional(),
  discovered: z.boolean().optional(),
  costBasisKnown: z.boolean(),
  balanceReadContext: earnBalanceReadContextSchema.optional(),
  feeSponsored: z.boolean(),
});

/** Runtime validation keeps an invalid or older response from hiding holdings. */
export const earnPositionsResponseSchema: z.ZodType<EarnPositionsResponse> = z.object({
  positions: z.array(earnCorePositionSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  balanceReadContext: earnBalanceReadContextSchema.optional(),
  summary: earnCoreSummarySchema.optional(),
  coverage: z.enum(["sdp_tracked_positions", "integrated_catalogue_positions"]),
  discovery: z
    .object({
      strategyCount: z.number().int().nonnegative(),
      unavailableStrategyCount: z.number().int().nonnegative(),
    })
    .optional(),
});

/** Discovery retains canonical strategy identity and rate units at the client boundary. */
export const earnDiscoveryResponseSchema: z.ZodType<EarnDiscoveryResponse> = z.object({
  strategies: z.array(
    z.looseObject({
      id: z.string(),
      provider: z.string(),
      providerReference: z.string(),
      name: z.string(),
      sourceKind: z.enum(["defi", "rwa"]),
      underlyingSource: z.string().optional(),
      depositMints: z.array(z.string()),
      shareMint: z.string().optional(),
      apyType: z.enum(["fixed", "variable"]),
      currentApy: z.string().optional(),
      liquidityTerm: z.enum(["instant", "delayed"]),
      redemptionDelayDays: z.number().optional(),
      riskMetadata: z.record(z.string(), z.unknown()).optional(),
      status: z.enum(["active", "paused", "deprecated"]),
      depositSlippage: slippage.nullable(),
      withdrawalSlippage: slippage.nullable(),
      hostCluster: z.enum(SOLANA_CLUSTERS),
      fundable: z.boolean(),
      feeSponsored: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
      rate: z.object({
        value: z.string().nullable(),
        measure: z.literal("apy"),
        basis: z.literal("provider_reported"),
        observedAt: z.string().nullable(),
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
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
