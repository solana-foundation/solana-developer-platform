/** Runtime contracts shared by Treasury response parsing and internal OpenAPI. */
import { z } from "zod";
import {
  EARN_MOVEMENT_STATUSES,
  EARN_PORTFOLIO_TOKENS,
  EARN_PORTFOLIO_WITHDRAWAL_STATUSES,
  EARN_PROGRAM_WITHDRAWAL_RECORD_STATUSES,
  EARN_VAULT_MOVEMENT_STATUSES,
  type EarnPortfolioWithdrawal,
  type EarnPortfolioWithdrawalPreview,
  type EarnProgramWithdrawalRecord,
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
  settlementOutcome: z.enum(["delivered", "cancelled"]).optional(),
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
  settlementOutcome: z.enum(["delivered", "cancelled"]).optional(),
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
  redemptionMode: z.enum(["standard", "instant"]).optional(),
  movementId: z.string(),
  settlementOutcome: z.enum(["delivered", "cancelled"]).optional(),
  positionId: z.string(),
  provider: z.string(),
  providerReference: z.string(),
  ownerAddress: z.string().nullable(),
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

/** A custodial program's live provider-read withdrawal (the legacy program flow). */
export const earnPortfolioWithdrawalSchema: z.ZodType<EarnPortfolioWithdrawal> = z.object({
  withdrawalRef: z.string(),
  status: z.enum(EARN_PORTFOLIO_WITHDRAWAL_STATUSES),
  amountRequestedUsd: z.string().optional(),
  amountPaidUsd: z.string().optional(),
  feeUsd: z.string().optional(),
  token: z.enum(EARN_PORTFOLIO_TOKENS).optional(),
  destinationAddress: z.string(),
  failureReason: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
});

/** What a lane preview answers: the amounts are decimal STRINGS, never numbers. */
export const earnPortfolioWithdrawalPreviewSchema: z.ZodType<EarnPortfolioWithdrawalPreview> =
  z.object({
    amountRequestedUsd: z.string().optional(),
    feeUsd: z.string(),
    withdrawableUsd: z.string(),
    totalUsdAfterWithdrawal: z.string(),
    processingEstimate: z
      .object({
        basis: z.enum(["elapsed_seconds", "banking_days"]),
        typicalMinDuration: z.string(),
        typicalMaxDuration: z.string(),
      })
      .optional(),
  });

/** One row of the SDP withdrawal ledger for a custodial program. */
export const earnProgramWithdrawalRecordSchema: z.ZodType<EarnProgramWithdrawalRecord> = z.object({
  id: z.string(),
  provider: z.string(),
  status: z.enum(EARN_PROGRAM_WITHDRAWAL_RECORD_STATUSES),
  amountRequestedUsd: z.string(),
  amountPaidUsd: z.string().optional(),
  feeUsd: z.string().optional(),
  token: z.enum(EARN_PORTFOLIO_TOKENS),
  destinationAddress: z.string(),
  failureReason: z.string().optional(),
  withdrawalRef: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});
