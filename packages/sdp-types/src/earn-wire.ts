/** Runtime contracts shared by Treasury response parsing and internal OpenAPI. */
import { z } from "zod";
import {
  EARN_MOVEMENT_STATUSES,
  EARN_VAULT_MOVEMENT_STATUSES,
  type EarnVaultDeposit,
  type EarnVaultDepositRecord,
  type EarnVaultWithdrawal,
} from "./earn";
import { SOLANA_CLUSTERS } from "./well-known-tokens";

export const earnBalanceReadContextSchema = z.object({
  afterMovementIds: z.array(z.string()).max(100),
  minimumSlot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const earnVaultDepositSchema: z.ZodType<EarnVaultDeposit> = z.object({
  positionId: z.string(),
  movementId: z.string(),
  status: z.enum(EARN_VAULT_MOVEMENT_STATUSES),
  signature: z.string(),
  failureReason: z.string().nullable(),
  replayed: z.boolean(),
  strategy: z.object({
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    providerReference: z.string(),
    hostCluster: z.enum(SOLANA_CLUSTERS),
  }),
});

export const earnVaultDepositRecordSchema: z.ZodType<EarnVaultDepositRecord> = z.object({
  movementId: z.string(),
  positionId: z.string(),
  provider: z.string(),
  providerReference: z.string(),
  status: z.enum(EARN_VAULT_MOVEMENT_STATUSES),
  signature: z.string(),
  amount: z.string(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
});

export const earnVaultWithdrawalSchema: z.ZodType<EarnVaultWithdrawal> = z.object({
  movementId: z.string(),
  positionId: z.string(),
  provider: z.string(),
  providerReference: z.string(),
  status: z.enum(EARN_MOVEMENT_STATUSES.vault_direct),
  signature: z.string(),
  shares: z.string(),
  shareMint: z.string(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  replayed: z.boolean().optional(),
});
