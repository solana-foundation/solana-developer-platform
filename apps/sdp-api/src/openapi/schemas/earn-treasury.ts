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
import {
  earnBalanceReadContextSchema,
  earnVaultDepositRecordSchema,
  earnVaultDepositSchema,
  earnVaultWithdrawalSchema,
} from "@sdp/types/earn-wire";
import { z } from "zod";
import { successResponseSchema, withOpenApi } from "@/openapi/schemas/base";
import * as requests from "@/routes/earn/schemas";
import {
  earnCursorQueryParams,
  earnDepositFundingFields,
  earnExternalWalletPositionLocatorSchema,
  earnExternalWalletPositionSchema,
  earnExternalWalletQueuedWithdrawalPreviewRequest,
  earnExternalWalletWithdrawalFields,
  earnExternalWalletWithdrawalPreviewResponseFields,
  earnMovementStatusQueryParam,
  earnParRedemptionPreviewFields,
  earnQueuedWithdrawalOptionsFields,
  earnQueuedWithdrawalPreviewFields,
} from "./earn";
import {
  EARN_EXAMPLE_IDS,
  EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE,
  EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
  EARN_TREASURY_MOVEMENTS_EXAMPLE,
  EARN_VAULT_DEPOSIT_EXAMPLE,
  EARN_VAULT_DEPOSIT_RECORD_EXAMPLE,
  EARN_VAULT_DEPOSIT_REQUEST_EXAMPLE,
  EARN_VAULT_DEPOSITS_EXAMPLE,
  EARN_VAULT_POSITIONS_EXAMPLE,
  EARN_VAULT_WITHDRAWAL_EXAMPLE,
  EARN_VAULT_WITHDRAWAL_FINALIZED_EXAMPLE,
  EARN_VAULT_WITHDRAWAL_PREVIEW_EXAMPLE,
  EARN_VAULT_WITHDRAWALS_EXAMPLE,
  EARN_WITHDRAWAL_OPTIONS_EXAMPLE,
  EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE,
} from "./earn-examples";

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

// ---------------------------------------------------------------------------
// Treasury requests, as the reference documents them. A custody wallet takes
// the same amounts, floors and withdrawal terms as a customer's wallet, so the
// field schemas are the Embedded Yield ones. Validation stays in the runtime
// schemas (routes/earn/schemas.ts); `earn-treasury.test.ts` pins the two together.
// ---------------------------------------------------------------------------

/** The key travels in the Idempotency-Key header: the runtime refuses a body `requestId`. */
const headerOnlyIdempotency = { not: { required: ["requestId"] } };

export const earnVaultDepositRequest = z
  .object({
    strategyId: z.string().min(1).openapi({
      description: "The strategy's `id` from the catalog.",
      example: EARN_EXAMPLE_IDS.strategy,
    }),
    custodyWalletId: z
      .string()
      .min(1)
      .openapi({
        description:
          "The custody wallet that signs the deposit and holds the shares: its `id` from " +
          "`GET /v1/wallets` (`cwlt_...`), not the custody provider's `walletId`. The API " +
          "key's wallet scope must include it.",
        example: EARN_EXAMPLE_IDS.custodyWallet,
      }),
    ...earnDepositFundingFields,
  })
  .openapi({
    ...headerOnlyIdempotency,
    description: "Deposit from one custody wallet into one strategy.",
  })
  .openapi({ example: EARN_VAULT_DEPOSIT_REQUEST_EXAMPLE });

const { feePayer: _feePayer, ...earnVaultWithdrawalFields } = earnExternalWalletWithdrawalFields;

export const earnVaultWithdrawalRequest = earnExternalWalletPositionLocatorSchema
  .extend(earnVaultWithdrawalFields)
  .openapi({
    ...headerOnlyIdempotency,
    description:
      "Withdraw shares from one custody position. SDP reads the strategy and the wallet " +
      "from the position.",
  })
  .openapi({ example: EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE });

// The runtime refuses unknown fields on the three bodies below, and the documents say so.
export const earnVaultWithdrawalOptionsRequest = earnExternalWalletPositionLocatorSchema
  .strict()
  .openapi({ description: "List the withdrawal routes a custody position supports right now." })
  .openapi({ example: EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE });

const [solverQueueTerms, operatorRedemptionTerms, heldIntermediateTerms] =
  earnExternalWalletQueuedWithdrawalPreviewRequest.options;
const withdrawalRequestTerms = [
  solverQueueTerms.strict(),
  operatorRedemptionTerms.strict(),
  heldIntermediateTerms.strict(),
] as const;

export const earnVaultQueuedWithdrawalPreviewRequest = z
  .union(withdrawalRequestTerms)
  .openapi({
    description:
      "Preview a solver queue or operator redemption request against live provider limits. " +
      "Read-only: nothing is built or saved.",
  })
  .openapi({ example: EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE });

/** The terms a queued preview takes, sent again to create the request. */
export const earnVaultWithdrawalRequestCreateRequest = z
  .union(withdrawalRequestTerms)
  .openapi({
    ...headerOnlyIdempotency,
    description:
      "Create a solver queue or operator redemption request. Send the terms you previewed.",
  })
  .openapi({ example: EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE });

const recordsQuery = requests.earnVaultDepositsQuerySchema;

/** The deposits and withdrawals lists share one query: a page, a recovery key, and an open filter. */
function earnVaultRecordsQuery(noun: "deposit" | "withdrawal") {
  return recordsQuery.extend({
    ...earnCursorQueryParams,
    requestId: withOpenApi(recordsQuery.shape.requestId, {
      description:
        `Return only the ${noun} created with this Idempotency-Key. Use it to recover a ` +
        `${noun} whose response you lost.`,
    }),
    settled: withOpenApi(recordsQuery.shape.settled, {
      description:
        `\`false\` returns only ${noun}s that can still change, \`true\` only final ones. ` +
        "Omit it for both.",
    }),
  });
}
export const earnVaultDepositsQuery = earnVaultRecordsQuery("deposit");
export const earnVaultWithdrawalsQuery = earnVaultRecordsQuery("withdrawal");

export const earnVaultPositionsQuery = requests.earnVaultPositionsQuerySchema.extend({
  ...earnCursorQueryParams,
  afterMovementIds: withOpenApi(requests.earnVaultPositionsQuerySchema.shape.afterMovementIds, {
    description:
      "Up to 100 comma-separated movement IDs. Each position they touched is read at or " +
      "after the slot they confirmed at, so its balance reflects them. A position that " +
      "cannot be read that fresh comes back without live values.",
    example: EARN_EXAMPLE_IDS.depositMovement,
  }),
});

const withdrawalRequestsQuery = requests.earnVaultWithdrawalRequestsQuerySchema;
export const earnVaultWithdrawalRequestsQuery = withdrawalRequestsQuery.extend({
  ...earnCursorQueryParams,
  settled: withOpenApi(withdrawalRequestsQuery.shape.settled, {
    description:
      "`false` returns only requests that still need fulfillment, classification or " +
      "cancellation, `true` only final ones. Omit it for both.",
  }),
  status: withOpenApi(withdrawalRequestsQuery.shape.status, {
    description: "Return only requests in this status.",
  }),
});

const movementsQuery = requests.earnMovementsQuerySchema;
export const earnMovementsQuery = movementsQuery.extend({
  ...earnCursorQueryParams,
  direction: withOpenApi(movementsQuery.shape.direction, {
    description: "Return only deposits or only withdrawals.",
  }),
  status: earnMovementStatusQueryParam,
  provider: withOpenApi(movementsQuery.shape.provider, {
    description: "Return only one provider's movements.",
    example: "kamino",
  }),
  positionId: withOpenApi(movementsQuery.shape.positionId, {
    description: "Return only one position's movements.",
    example: EARN_EXAMPLE_IDS.position,
  }),
  sourceAddress: withOpenApi(movementsQuery.shape.sourceAddress, {
    description: "Return only movements whose funds left this address.",
  }),
  destinationAddress: withOpenApi(movementsQuery.shape.destinationAddress, {
    description: "Return only movements whose funds arrived at this address.",
  }),
});

export const earnVaultDepositParams = requests.earnVaultDepositParamsSchema.extend({
  movementId: withOpenApi(requests.earnVaultDepositParamsSchema.shape.movementId, {
    description: "The `movementId` the deposit returned.",
    example: EARN_EXAMPLE_IDS.depositMovement,
  }),
});
export const earnVaultWithdrawalParams = requests.earnVaultWithdrawalParamsSchema.extend({
  movementId: withOpenApi(requests.earnVaultWithdrawalParamsSchema.shape.movementId, {
    description: "The `movementId` the withdrawal returned.",
    example: EARN_EXAMPLE_IDS.withdrawalMovement,
  }),
});
const withdrawalRequestParams = requests.earnVaultWithdrawalRequestParamsSchema;
export const earnVaultWithdrawalRequestParams = withdrawalRequestParams.extend({
  withdrawalRequestId: withOpenApi(withdrawalRequestParams.shape.withdrawalRequestId, {
    description: "The `withdrawalRequestId` the request returned.",
    example: EARN_EXAMPLE_IDS.withdrawalRequest,
  }),
});

// ---------------------------------------------------------------------------
// Treasury responses. Deposit and withdrawal records come from
// `@sdp/types/earn-wire`, which the dashboard parses with too.
// ---------------------------------------------------------------------------

export const earnVaultDepositResponse = successResponseSchema(
  withOpenApi(earnVaultDepositSchema, { example: EARN_VAULT_DEPOSIT_EXAMPLE })
);
export const earnVaultDepositRecordResponse = envelope({
  deposit: withOpenApi(earnVaultDepositRecordSchema, {
    example: EARN_VAULT_DEPOSIT_RECORD_EXAMPLE,
  }),
});
export const earnVaultDepositsResponse = successResponseSchema(
  z
    .object({ deposits: z.array(earnVaultDepositRecordSchema), ...pageFields })
    .openapi({ example: EARN_VAULT_DEPOSITS_EXAMPLE })
);
/** The create response: recorded and broadcast. */
export const earnVaultWithdrawalResponse = envelope({
  withdrawal: withOpenApi(earnVaultWithdrawalSchema, { example: EARN_VAULT_WITHDRAWAL_EXAMPLE }),
});
/** The same record read back once it is final. */
export const earnVaultWithdrawalRecordResponse = envelope({
  withdrawal: withOpenApi(earnVaultWithdrawalSchema, {
    example: EARN_VAULT_WITHDRAWAL_FINALIZED_EXAMPLE,
  }),
});
export const earnVaultWithdrawalsResponse = successResponseSchema(
  z
    .object({ withdrawals: z.array(earnVaultWithdrawalSchema), ...pageFields })
    .openapi({ example: EARN_VAULT_WITHDRAWALS_EXAMPLE })
);

export const earnVaultPositionSchema = earnExternalWalletPositionSchema
  .omit({ ownerAddress: true })
  .extend({
    custodyWalletId: z.string().openapi({
      description: "The custody wallet that holds the shares: its `id` from `GET /v1/wallets`.",
      example: EARN_EXAMPLE_IDS.custodyWallet,
    }),
    feeSponsored: z.boolean().openapi({
      description:
        "Whether SDP pays the network fee for a withdrawal from this position. When false, " +
        "the custody wallet needs SOL for it.",
    }),
  }) satisfies z.ZodType<EarnVaultPosition>;
export const earnVaultPositionsResponse = successResponseSchema(
  z
    .object({
      positions: z.array(earnVaultPositionSchema),
      balanceReadContext: earnBalanceReadContextSchema.optional().openapi({
        description: "Present when the request sent `afterMovementIds`.",
      }),
      ...pageFields,
    })
    .openapi({ example: EARN_VAULT_POSITIONS_EXAMPLE })
);
export const earnVaultWithdrawalPreviewResponse = successResponseSchema(
  z
    .object({
      positionId: z.string(),
      ...earnExternalWalletWithdrawalPreviewResponseFields,
      feeSponsored: z.boolean().openapi({
        description: "Whether SDP pays the network fee for this withdrawal.",
      }),
    })
    .openapi({ example: EARN_VAULT_WITHDRAWAL_PREVIEW_EXAMPLE })
);
export const earnVaultWithdrawalOptionsResponse = successResponseSchema(
  z
    .object({ positionId: z.string(), ...earnQueuedWithdrawalOptionsFields })
    .openapi({ example: EARN_WITHDRAWAL_OPTIONS_EXAMPLE })
);
export const earnVaultQueuedWithdrawalPreviewResponse = successResponseSchema(
  z
    .union([
      z.object({ positionId: z.string(), ...earnQueuedWithdrawalPreviewFields }),
      z.object({ positionId: z.string(), ...earnParRedemptionPreviewFields }),
    ])
    .openapi({ example: EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE })
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
  id: z.string().openapi({ example: EARN_EXAMPLE_IDS.depositMovement }),
  provider: z.string().openapi({ example: "kamino" }),
  executionModel: z.enum(["custodial", "vault_direct"]).openapi({
    description:
      "`vault_direct`: a deposit or withdrawal SDP signed from a custody wallet. " +
      "`custodial`: a movement in a provider-managed program.",
  }),
  direction: z.enum(["deposit", "withdrawal"]),
  status: z
    .enum([...EARN_MOVEMENT_STATUSES.custodial, ...EARN_MOVEMENT_STATUSES.vault_direct])
    .openapi({
      description:
        "A `vault_direct` movement goes `requested`, `submitted`, `confirmed`, then " +
        "`finalized`, or `failed`; only `finalized` and `failed` are final. The other " +
        "values belong to provider programs.",
    }),
  positionId: z.string().openapi({ description: "The position the movement belongs to." }),
  denomination: z.string().openapi({
    description:
      "The unit of `amountRequested` and `amountSettled`: the deposit-token mint for a " +
      "deposit, the share mint for a withdrawal, or `usd` for a provider program.",
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
  minSharesOut: z.string().optional().openapi({
    description: "The deposit's slippage floor in share units, when it carried one.",
  }),
  sharesOut: z.string().optional().openapi({
    description: "Shares a deposit received, once observed.",
  }),
  payoutToken: z.string().optional().openapi({
    description: "A provider-program withdrawal's payout stablecoin symbol; not the unit.",
  }),
  vaultAddress: z.string().optional().openapi({
    description: "The strategy's onchain address.",
  }),
  sourceAddress: z.string().optional().openapi({
    description: "Where the funds came from, once SDP observed it.",
  }),
  destinationAddress: z.string().optional().openapi({
    description: "Where the funds went, once SDP observed it.",
  }),
  providerReference: z.string().optional().openapi({
    description: "The provider's own ID for this movement, when it has one.",
  }),
  signature: z.string().optional().openapi({
    description: "The transaction's signature, for a `vault_direct` movement.",
  }),
  failureReason: z.string().optional(),
  createdBy: z.string().optional().openapi({
    description: "The dashboard member who started the movement, when one did.",
  }),
  initiatedByKeyId: z.string().optional().openapi({
    description: "The API key that started the movement, when one did.",
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().optional().openapi({
    description: "When the network confirmed it. Not settlement.",
  }),
  settledAt: z.string().optional().openapi({
    description: "When it became final, or the provider completed it.",
  }),
}) satisfies z.ZodType<EarnMovementRecord>;
export const earnMovementsResponse = successResponseSchema(
  z
    .object({ movements: z.array(earnMovementSchema), ...pageFields })
    .openapi({ example: EARN_TREASURY_MOVEMENTS_EXAMPLE })
);
