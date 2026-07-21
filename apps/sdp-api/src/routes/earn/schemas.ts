import {
  EARN_APY_TYPES,
  EARN_LIQUIDITY_TERMS,
  EARN_MOVEMENT_DIRECTIONS,
  EARN_STRATEGY_SOURCE_KINDS,
} from "@sdp/types";
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
