import { EARN_APY_TYPES, EARN_LIQUIDITY_TERMS, EARN_STRATEGY_SOURCE_KINDS } from "@sdp/types/earn";
import { SOLANA_CLUSTERS } from "@sdp/types/well-known-tokens";
import { isAddress } from "@solana/addresses";
import { z } from "zod";

const earnPageQueryShape = {
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const listEarnStrategiesQuerySchema = z.object({
  ...earnPageQueryShape,
  sourceKind: z.enum(EARN_STRATEGY_SOURCE_KINDS).optional(),
  apyType: z.enum(EARN_APY_TYPES).optional(),
  liquidityTerm: z.enum(EARN_LIQUIDITY_TERMS).optional(),
  // Explicit cluster opt-in (PRO-1742). Omitted, the list answers the
  // environment's own cluster — the shelf the caller can act on. Naming the
  // foreign cluster browses its mirrored sub-shelf; rows stay fundable: false.
  cluster: z.enum(SOLANA_CLUSTERS).optional(),
});

const solanaOwnerAddressSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().refine((value) => value.length >= 32 && value.length <= 44 && isAddress(value), {
    message: "ownerAddress must be a base58 Solana address",
  })
);

export const earnWalletPositionsQuerySchema = z
  .object({
    ownerAddress: solanaOwnerAddressSchema,
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before: z.string().min(1).optional(),
  })
  .strict();

export const earnVaultPositionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().min(1).optional(),
  afterMovementIds: z
    .string()
    .max(12_899)
    .regex(/^[A-Za-z0-9_-]{1,128}(,[A-Za-z0-9_-]{1,128}){0,99}$/)
    .optional(),
});
