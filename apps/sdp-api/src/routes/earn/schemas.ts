import { isAddress } from "@sdp/solana/address";
import {
  EARN_APY_TYPES,
  EARN_LIQUIDITY_TERMS,
  EARN_PORTFOLIO_TOKENS,
  EARN_STRATEGY_SOURCE_KINDS,
} from "@sdp/types";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";

export const earnStrategyIdParamsSchema = z.object({
  strategyId: z.string().min(1),
});

export const listEarnStrategiesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sourceKind: z.enum(EARN_STRATEGY_SOURCE_KINDS).optional(),
  apyType: z.enum(EARN_APY_TYPES).optional(),
  liquidityTerm: z.enum(EARN_LIQUIDITY_TERMS).optional(),
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
  /**
   * Caller-owned idempotency key (UUIDv4), forwarded to the provider so a
   * retried confirm cannot provision a second wallet or apply a strategy twice.
   * Same contract as the withdrawal path: the provider replays the original
   * response for a matching payload and conflicts on a mismatch, so callers must
   * mint a NEW id whenever the allocation changes. The server mints one per call
   * when absent, which is not idempotent — send your own to get that guarantee.
   */
  requestId: z.uuidv4().optional(),
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
  /**
   * Caller-owned idempotency key (UUIDv4). Optional HERE only because the
   * `Idempotency-Key` header is the other accepted source — the handler
   * requires EXACTLY one and refuses both neither and both, since the provider
   * dedupes a withdrawal on this key alone and no precedence rule can tell
   * which of two sources a caller's retry keeps stable. Either way the value
   * is derived against the program wallet before it reaches the provider, so
   * one organization's key can never collide with another's on the shared
   * account.
   */
  requestId: z.uuidv4().optional(),
  destinationAddress: solanaDestinationSchema,
});

export const earnProgramWithdrawalParamsSchema = z.object({
  withdrawalRef: z.string().min(1),
});

/**
 * Withdrawal-ledger list (DB read). The provider param stays registry-gated
 * like every program read — ADR 0002's open-string rule governs stored values
 * and dispatch, not query validation, and de-registration only ever happens
 * after a provider is drained.
 */
export const earnProgramWithdrawalsListQuerySchema = z.object({
  provider: earnProviderSchema,
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
