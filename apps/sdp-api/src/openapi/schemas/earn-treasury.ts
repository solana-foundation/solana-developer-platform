export {
  earnVaultDepositRecordSchema,
  earnVaultDepositSchema,
  earnVaultWithdrawalSchema,
} from "@sdp/types/earn-wire";

import {
  EARN_MOVEMENT_STATUSES,
  EARN_PORTFOLIO_DEPOSIT_STATUSES,
  EARN_PORTFOLIO_POSITION_KINDS,
  EARN_PORTFOLIO_TOKENS,
  EARN_PORTFOLIO_WALLET_ACTIVITIES,
  EARN_PORTFOLIO_WALLET_STATUSES,
  EARN_PORTFOLIO_WITHDRAWAL_STATUSES,
  type EarnMovementRecord,
  type EarnPortfolioDeposit,
  type EarnPortfolioWithdrawal,
  type EarnPortfolioWithdrawalPreview,
  type EarnProgram,
  type EarnProgramWithdrawalRecord,
  type EarnVaultPosition,
} from "@sdp/types";
import { successResponseSchema, z } from "./base";
import {
  earnExternalWalletPositionSchema,
  earnExternalWalletWithdrawalPreviewResponseFields,
  earnParRedemptionPreviewFields,
  earnQueuedWithdrawalOptionsFields,
  earnQueuedWithdrawalPreviewFields,
} from "./earn";

export const pageFields = { hasMore: z.boolean(), nextCursor: z.string().nullable() };
export const listFields = {
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
};
export const envelope = (shape: z.ZodRawShape) => successResponseSchema(z.object(shape));

export const earnVaultPositionSchema = earnExternalWalletPositionSchema
  .omit({ ownerAddress: true })
  .extend({
    custodyWalletId: z.string(),
    feeSponsored: z.boolean(),
  }) satisfies z.ZodType<EarnVaultPosition>;
export const earnVaultWithdrawalPreviewResponse = envelope({
  positionId: z.string(),
  ...earnExternalWalletWithdrawalPreviewResponseFields,
  feeSponsored: z.boolean(),
});
export const earnVaultWithdrawalOptionsResponse = envelope({
  positionId: z.string(),
  ...earnQueuedWithdrawalOptionsFields,
});
export const earnVaultQueuedWithdrawalPreviewResponse = successResponseSchema(
  z.union([
    z.object({ positionId: z.string(), ...earnQueuedWithdrawalPreviewFields }),
    z.object({ positionId: z.string(), ...earnParRedemptionPreviewFields }),
  ])
);

const token = z.enum(EARN_PORTFOLIO_TOKENS);
const target = z.array(z.object({ yieldSourceId: z.string(), weightBps: z.number() }));
export const earnProgramSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
  wallet: z.object({
    providerWalletRef: z.string(),
    status: z.enum(EARN_PORTFOLIO_WALLET_STATUSES),
    activity: z.enum(EARN_PORTFOLIO_WALLET_ACTIVITIES).optional(),
    providerStatus: z.string().optional(),
    solanaDepositAddress: z.string().optional(),
    balance: z.object({
      totalUsd: z.string(),
      withdrawableUsd: z.string(),
      reservedUsd: z.string(),
      earnedUsd: z.string(),
    }),
    positions: z.array(
      z.object({
        kind: z.enum(EARN_PORTFOLIO_POSITION_KINDS),
        label: z.string(),
        valueUsd: z.string(),
        pct: z.number().optional(),
        yieldSourceId: z.string().optional(),
        token: token.optional(),
      })
    ),
    allocations: z.partialRecord(token, target),
  }),
  yield: z
    .object({
      currentApy: z.string().optional(),
      earnedUsd: z.string(),
      annualizedUsd: z.string().optional(),
      positions: z.array(
        z.object({
          yieldSourceId: z.string(),
          name: z.string(),
          apy: z.string(),
          pct: z.number(),
          deployedValueUsd: z.string(),
        })
      ),
    })
    .optional(),
}) satisfies z.ZodType<EarnProgram>;
export const earnPortfolioDepositSchema = z.object({
  id: z.string(),
  amountUsd: z.string(),
  token,
  status: z.enum(EARN_PORTFOLIO_DEPOSIT_STATUSES),
  fromAddress: z.string().optional(),
  transactionSignature: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
}) satisfies z.ZodType<EarnPortfolioDeposit>;
const programWithdrawalFields = {
  status: z.enum(EARN_PORTFOLIO_WITHDRAWAL_STATUSES),
  amountRequestedUsd: z.string().optional(),
  amountPaidUsd: z.string().optional(),
  feeUsd: z.string().optional(),
  token: token.optional(),
  destinationAddress: z.string(),
  failureReason: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
};
export const earnPortfolioWithdrawalSchema = z.object({
  withdrawalRef: z.string(),
  ...programWithdrawalFields,
}) satisfies z.ZodType<EarnPortfolioWithdrawal>;
export const earnProgramWithdrawalRecordSchema = z.object({
  ...programWithdrawalFields,
  id: z.string(),
  provider: z.string(),
  status: z.enum(["requested", ...EARN_PORTFOLIO_WITHDRAWAL_STATUSES]),
  amountRequestedUsd: z.string(),
  token,
  withdrawalRef: z.string().optional(),
  updatedAt: z.string(),
}) satisfies z.ZodType<EarnProgramWithdrawalRecord>;
export const earnProgramWithdrawalPreviewSchema = z.object({
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
}) satisfies z.ZodType<EarnPortfolioWithdrawalPreview>;
export const earnMovementSchema = z.object({
  id: z.string(),
  provider: z.string(),
  executionModel: z.enum(["custodial", "vault_direct"]),
  direction: z.enum(["deposit", "withdrawal"]),
  status: z.enum([...EARN_MOVEMENT_STATUSES.custodial, ...EARN_MOVEMENT_STATUSES.vault_direct]),
  positionId: z.string(),
  denomination: z.string(),
  amountRequested: z.string(),
  amountSettled: z.string().optional(),
  tokenAmount: z.string().optional(),
  tokenMint: z.string().optional(),
  feeAmount: z.string().optional(),
  minSharesOut: z.string().optional(),
  sharesOut: z.string().optional(),
  payoutToken: z.string().optional(),
  vaultAddress: z.string().optional(),
  sourceAddress: z.string().optional(),
  destinationAddress: z.string().optional(),
  providerReference: z.string().optional(),
  signature: z.string().optional(),
  failureReason: z.string().optional(),
  createdBy: z.string().optional(),
  initiatedByKeyId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().optional(),
  settledAt: z.string().optional(),
}) satisfies z.ZodType<EarnMovementRecord>;
