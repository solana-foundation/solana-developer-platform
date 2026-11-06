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
} from "@sdp/types/earn";
import { z } from "zod";
import { successResponseSchema } from "@/openapi/schemas/base";
import {
  earnExternalWalletPositionSchema,
  earnExternalWalletWithdrawalPreviewResponseFields,
  earnParRedemptionPreviewFields,
  earnQueuedWithdrawalOptionsFields,
  earnQueuedWithdrawalPreviewFields,
} from "./earn";

export const pageFields = {
  hasMore: z.boolean(),
  nextCursor: z.string().nullable().openapi({
    description: "Pass as before to read the next page. Null when no more rows remain.",
  }),
};
export const listFields = {
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
};
export const envelope = (shape: z.ZodRawShape) => successResponseSchema(z.object(shape));

export const earnVaultPositionSchema = earnExternalWalletPositionSchema
  .omit({ ownerAddress: true })
  .extend({
    custodyWalletId: z.string().openapi({ example: "cwlt_example" }),
    feeSponsored: z.boolean().openapi({
      description: "Whether SDP's configured paymaster would sponsor this position's vault flow.",
    }),
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

const token = z.enum(EARN_PORTFOLIO_TOKENS).openapi({ example: "usdc" });
const target = z.array(
  z.object({
    yieldSourceId: z.string(),
    weightBps: z.number().openapi({
      description: "Allocation weight in basis points; 10000 means 100 percent.",
      example: 10_000,
    }),
  })
);
export const earnProgramSchema = z.object({
  id: z.string().openapi({
    description: "SDP program ID used by the programs endpoints.",
    example: "earn_provider_wallet_example",
  }),
  provider: z.string().openapi({ example: "perena" }),
  label: z.string().nullable(),
  createdAt: z.string(),
  wallet: z.object({
    providerWalletRef: z.string(),
    status: z.enum(EARN_PORTFOLIO_WALLET_STATUSES),
    activity: z.enum(EARN_PORTFOLIO_WALLET_ACTIVITIES).optional(),
    providerStatus: z.string().optional(),
    solanaDepositAddress: z.string().optional().openapi({
      description: "Provider wallet's Solana funding address, when available.",
    }),
    balance: z.object({
      totalUsd: z.string().openapi({
        description: "Live total provider balance in USD.",
        example: "1000.00",
      }),
      withdrawableUsd: z.string().openapi({
        description: "USD value the provider currently permits to withdraw.",
        example: "980.00",
      }),
      reservedUsd: z.string().openapi({
        description: "USD value currently reserved by the provider.",
        example: "20.00",
      }),
      earnedUsd: z.string().openapi({
        description: "Provider-reported cumulative yield in USD.",
        example: "12.34",
      }),
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
    allocations: z.partialRecord(token, target).openapi({
      description:
        "Live provider allocations. Response weights use basis points; requests use pct.",
    }),
  }),
  yield: z
    .object({
      currentApy: z.string().optional().openapi({
        description: "Blended APY as a decimal ratio; 0.062 means 6.2 percent.",
        example: "0.062",
      }),
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
    .optional()
    .openapi({
      description:
        "Live yield breakdown. Absent if the yield read fails; wallet balances remain live.",
    }),
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
  denomination: z.string().openapi({
    description: "usd for provider programs; token or share mint for vault movements.",
  }),
  amountRequested: z.string().openapi({
    description: "Requested quantity in denomination units. Withdrawals may be share-denominated.",
    example: "25",
  }),
  amountSettled: z.string().optional().openapi({
    description: "Observed settled quantity in the same denomination as amountRequested.",
  }),
  tokenAmount: z.string().optional().openapi({
    description:
      "Observed finalized vault-withdrawal payout, in tokenMint units. Absent if unvalued.",
  }),
  tokenMint: z.string().optional().openapi({
    description: "Deposit-token mint denominating tokenAmount, when payout was observed.",
  }),
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
