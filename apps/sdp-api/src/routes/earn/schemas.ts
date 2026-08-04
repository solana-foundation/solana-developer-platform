import { isAddress } from "@sdp/solana/address";
import {
  EARN_APY_TYPES,
  EARN_LIQUIDITY_TERMS,
  EARN_MOVEMENT_DIRECTIONS,
  EARN_PORTFOLIO_TOKENS,
  EARN_STRATEGY_SOURCE_KINDS,
} from "@sdp/types";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";

export const earnStrategyIdParamsSchema = z.object({
  strategyId: z.string().min(1),
});

export const earnPositionIdParamsSchema = z.object({
  positionId: z.string().min(1),
});

export const earnMovementIdParamsSchema = z.object({
  movementId: z.string().min(1),
});

export const listEarnStrategiesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sourceKind: z.enum(EARN_STRATEGY_SOURCE_KINDS).optional(),
  apyType: z.enum(EARN_APY_TYPES).optional(),
  liquidityTerm: z.enum(EARN_LIQUIDITY_TERMS).optional(),
});

export const earnNavHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(90),
});

/**
 * Strict query-string boolean: z.coerce.boolean() would turn "false"/"0" into
 * true (Boolean(non-empty string)), silently inverting the caller's intent on
 * a public API. Absent means false; anything but "true"/"false" is a 400.
 */
const queryFlagSchema = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

export const listEarnPositionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  strategyId: z.string().min(1).optional(),
  includeClosed: queryFlagSchema,
});

export const listEarnMovementsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  positionId: z.string().min(1).optional(),
  direction: z.enum(EARN_MOVEMENT_DIRECTIONS).optional(),
});

/** Amounts travel as positive base-unit integer strings, never floats. */
const baseUnitAmountSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "Amount must be a positive base-unit integer string");

export const earnDepositQuoteSchema = z.object({
  strategyId: z.string().min(1),
  tokenMint: z.string().min(1),
  amount: baseUnitAmountSchema,
});

export const earnWithdrawalQuoteSchema = z
  .object({
    strategyId: z.string().min(1),
    tokenMint: z.string().min(1),
    amount: baseUnitAmountSchema.optional(),
    shareAmount: baseUnitAmountSchema.optional(),
  })
  .refine((value) => (value.amount !== undefined) !== (value.shareAmount !== undefined), {
    message: "Provide exactly one of amount or shareAmount",
  });

// ---------------------------------------------------------------------------
// Shared portfolio program (ONE provider wallet per organization+environment).
// ---------------------------------------------------------------------------

/** Writes stay closed to registered provider ids (ADR 0002 drift rule). */
const earnProviderSchema = z.enum(EARN_PROVIDERS);

/**
 * Strategy weights are authored in percent with 0.1 granularity (the wire
 * contract converts to basis points). Validate the step in tenths — a naive
 * `multipleOf(0.1)` trips on binary-float remainders like 0.3 % 0.1.
 */
const allocationPctSchema = z
  .number()
  .gt(0)
  .max(100)
  .refine((pct) => Math.abs(pct * 10 - Math.round(pct * 10)) < 1e-9, {
    message: "pct must be a multiple of 0.1",
  });

const allocationSchema = z.object({
  yieldSourceId: z.string().min(1),
  pct: allocationPctSchema,
});

const allocationGroupSchema = z
  .array(allocationSchema)
  .min(1)
  .max(20)
  .superRefine((entries, ctx) => {
    if (new Set(entries.map((entry) => entry.yieldSourceId)).size !== entries.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate yieldSourceId in allocation group" });
    }
    // Sum in integer tenths so 33.3 + 33.3 + 33.4 lands exactly on 100.
    const tenths = entries.reduce((sum, entry) => sum + Math.round(entry.pct * 10), 0);
    if (tenths !== 1000) {
      ctx.addIssue({ code: "custom", message: "Allocation weights must sum to exactly 100" });
    }
  });

// Keys mirror EARN_PORTFOLIO_TOKENS; tokens omitted keep their current allocation.
const earnProgramAllocationsSchema = z
  .object({
    usdc: allocationGroupSchema.optional(),
    usdt: allocationGroupSchema.optional(),
  })
  .refine((groups) => EARN_PORTFOLIO_TOKENS.some((token) => groups[token] !== undefined), {
    message: "allocations must include at least one deposit token group",
  });

export const earnProgramUpsertSchema = z.object({
  provider: earnProviderSchema,
  label: z.string().trim().min(1).max(120).optional(),
  allocations: earnProgramAllocationsSchema,
});

export const earnProgramQuerySchema = z.object({
  provider: earnProviderSchema,
});

export const earnProgramDepositsQuerySchema = z.object({
  provider: earnProviderSchema,
  cursor: z.string().min(1).optional(),
});

/** Portfolio flows travel in USD decimal strings, never floats. */
const usdAmountSchema = z
  .string()
  .regex(/^(?!0+(?:\.0+)?$)\d+(?:\.\d{1,6})?$/, "Amount must be a positive USD decimal string");

// Same trim + isAddress convention as payments' solanaAddressSchema: validate
// here for an actionable 400 instead of a provider-side failure downstream.
const solanaDestinationSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().refine((value) => value.length >= 32 && value.length <= 44 && isAddress(value), {
    message: "destinationAddress must be a base58 Solana address",
  })
);

export const earnProgramWithdrawalPreviewSchema = z.object({
  provider: earnProviderSchema,
  amountUsd: usdAmountSchema,
  token: z.enum(EARN_PORTFOLIO_TOKENS),
});

export const earnProgramWithdrawalCreateSchema = earnProgramWithdrawalPreviewSchema.extend({
  /** Caller-owned idempotency key (UUIDv4); the server mints one when absent. */
  requestId: z.uuidv4().optional(),
  destinationAddress: solanaDestinationSchema,
});

export const earnProgramWithdrawalParamsSchema = z.object({
  withdrawalRef: z.string().min(1),
});
