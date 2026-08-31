import { isoDateTimeSchema, successResponseSchema, z } from "./base";

// ---------------------------------------------------------------------------
// External-wallet (caller-signed) vault flows (PRO-1722): SDP builds an
// unsigned transaction for a wallet it does not custody, the owner signs it,
// and the submit records the movement before SDP broadcasts.
// ---------------------------------------------------------------------------

const solanaAddressExample = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const earnOwnerAddressSchema = z
  .string()
  .min(32)
  .max(44)
  // Base58 shape, matching the runtime's trim + isAddress refusal.
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .openapi({
    description:
      "The external wallet: the customer's own Solana address. It signs, owns the shares, " +
      "and pays the fee; SDP holds no key for it. The pattern is necessary but not " +
      "sufficient — the string must additionally decode to a 32-byte public key, which no " +
      "pattern can express, so a well-shaped base58 string that does not decode still " +
      "answers 400.",
    example: solanaAddressExample,
  });

const earnDecimalAmountSchema = z
  .string()
  .max(128)
  // The runtime additionally refuses an all-zero value; the lookahead encodes
  // that same non-zero rule in the published pattern.
  .regex(/^(?=.*[1-9])\d+(\.\d+)?$/)
  .openapi({
    description: "Positive decimal string with at least one non-zero digit; never a float.",
    example: "25",
  });

export const earnExternalWalletDepositTransactionRequest = z
  .object({
    strategyId: z.string().min(1).openapi({ example: "earn_strategy_example" }),
    ownerAddress: earnOwnerAddressSchema,
    amount: earnDecimalAmountSchema.openapi({
      description: "Deposit amount in the vault token's units, as a decimal string.",
      example: "25",
    }),
    minSharesOut: earnDecimalAmountSchema.optional().openapi({
      description:
        "Slippage floor in share units. Optional in sandbox; required for production deposits.",
      example: "24.9",
    }),
  })
  .openapi({ description: "Build one unsigned deposit transaction for an external wallet." });

export const earnExternalWalletWithdrawalTransactionRequest = z
  .object({
    positionId: z.string().min(1).max(128).openapi({ example: "earn_position_example" }),
    shares: earnDecimalAmountSchema.openapi({
      description: "Shares to redeem, decimal string in share units.",
      example: "10",
    }),
  })
  .openapi({
    description:
      "Build one unsigned exit transaction for an external-wallet position. The position " +
      "carries the vault and both mints, so a delisted vault stays exitable.",
  });

export const earnExternalWalletSubmitRequest = z
  .object({
    transactionId: z.string().min(1).max(128).openapi({
      description: "The built transaction being submitted; single-use.",
      example: "earn_external_wallet_transaction_example",
    }),
    signedTransaction: z
      .string()
      .min(1)
      .max(1700)
      // Base64 only, matching the runtime schema; anything else could never
      // decode into a transaction.
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .openapi({
        description:
          "Base64 wire bytes of the signed transaction. They must be byte-for-byte the built " +
          "message with only signatures added.",
        example:
          "AUyx/sEc49/1l6jxo3nbViPAIUqdrXCo8Qx5SfDvIbtUI0zex3Bi6Cyhhn1QTVU8zWDzXTRyIX2aCmq9v7yk5AOAAQABAvSV602SJ67iQCUGLwHzVtPnlMbZqL79wnV/nb+Mi9SJBUpTWpkpIQZNJOhxYNo4fHw1td28kruB5B+oQEEFRI0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAtzZHAtZXhhbXBsZQA=",
      }),
  })
  .openapi({
    description:
      "Submit the signed bytes back. Requires the Idempotency-Key header; a retry with the " +
      "same key resolves the original movement instead of moving money twice.",
  });

const earnExternalWalletTransactionSchema = z
  .object({
    transactionId: z.string().openapi({ example: "earn_external_wallet_transaction_example" }),
    transaction: z.string().openapi({
      description:
        "Base64 wire bytes of the UNSIGNED transaction for the external wallet to sign. It " +
        "expires with its blockhash (about a minute).",
    }),
    lastValidBlockHeight: z.string().openapi({ example: "361186610" }),
    ownerAddress: earnOwnerAddressSchema,
    provider: z.string().openapi({ example: "kamino" }),
    providerReference: z.string().openapi({
      description: "The vault's on-chain address — the instrument.",
      example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
    }),
    tokenMint: z.string().openapi({ example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
    shareMint: z.string().openapi({ example: "hXm2xSRF5PLKGMrTvAWqKhR76MuJX5dAabeSChkjqu2" }),
  })
  .openapi({ description: "One unsigned transaction SDP built for an external wallet to sign." });

const earnExternalWalletDepositTransactionSchema = earnExternalWalletTransactionSchema
  .extend({
    amount: earnDecimalAmountSchema,
    minSharesOut: earnDecimalAmountSchema.nullable(),
    strategy: z.object({
      id: z.string().openapi({ example: "earn_strategy_example" }),
      name: z.string().openapi({ example: "Allez USDC" }),
      provider: z.string().openapi({ example: "kamino" }),
      providerReference: z.string().openapi({
        example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
      }),
      hostCluster: z.string().openapi({ example: "devnet" }),
    }),
  })
  .openapi({ description: "The built deposit transaction plus the strategy it targets." });

const earnExternalWalletWithdrawalTransactionSchema = earnExternalWalletTransactionSchema
  .extend({
    positionId: z.string().openapi({ example: "earn_position_example" }),
    shares: earnDecimalAmountSchema,
  })
  .openapi({ description: "The built exit transaction plus the position it redeems from." });

const earnExternalWalletMovementSchema = z
  .object({
    movementId: z.string().openapi({ example: "earn_movement_example" }),
    positionId: z.string().openapi({ example: "earn_position_example" }),
    provider: z.string().openapi({ example: "kamino" }),
    providerReference: z.string().openapi({
      example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
    }),
    direction: z.enum(["deposit", "withdrawal"]),
    status: z.enum(["requested", "submitted", "confirmed", "finalized", "failed"]).openapi({
      description:
        "Ledger vocabulary. `confirmed` is optimistic and can still be dropped by a fork; " +
        "only `finalized` and `failed` are terminal.",
    }),
    signature: z.string().openapi({ description: "The transaction signature, for explorers." }),
    ownerAddress: earnOwnerAddressSchema,
    amount: earnDecimalAmountSchema.openapi({
      description: "Requested quantity, denominated in `denomination`.",
    }),
    denomination: z.string().openapi({
      description: "Token mint for a deposit; share mint for a withdrawal.",
      example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    }),
    failureReason: z.string().nullable(),
    createdAt: isoDateTimeSchema,
    confirmedAt: isoDateTimeSchema.nullable(),
    settledAt: isoDateTimeSchema.nullable(),
    replayed: z.boolean().optional().openapi({
      description:
        "True when the idempotency key already produced this movement and nothing was re-sent.",
    }),
  })
  .openapi({ description: "One recorded external-wallet vault movement." });

export const earnExternalWalletDepositTransactionResponse = successResponseSchema(
  z.object({ transaction: earnExternalWalletDepositTransactionSchema })
);

export const earnExternalWalletWithdrawalTransactionResponse = successResponseSchema(
  z.object({ transaction: earnExternalWalletWithdrawalTransactionSchema })
);

export const earnExternalWalletDepositResponse = successResponseSchema(
  z.object({ deposit: earnExternalWalletMovementSchema })
);

export const earnExternalWalletWithdrawalResponse = successResponseSchema(
  z.object({ withdrawal: earnExternalWalletMovementSchema })
);

const earnLiveDecimalAmountSchema = z
  .string()
  .max(128)
  .regex(/^\d+(\.\d+)?$/)
  .openapi({
    description: "Live decimal value returned by the vault provider; never a float.",
    example: "25.42",
  });

const earnExternalWalletPositionSchema = z
  .object({
    id: z.string().openapi({ example: "earn_position_example" }),
    ownerAddress: earnOwnerAddressSchema,
    provider: z.string().openapi({ example: "kamino" }),
    providerReference: z.string().openapi({
      description: "The vault's on-chain address.",
      example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
    }),
    label: z.string().openapi({ example: "Allez USDC" }),
    tokenMint: z.string().openapi({ example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
    shareMint: z.string().openapi({ example: "hXm2xSRF5PLKGMrTvAWqKhR76MuJX5dAabeSChkjqu2" }),
    createdAt: isoDateTimeSchema,
    closedAt: isoDateTimeSchema.nullable(),
    shares: earnLiveDecimalAmountSchema.optional().openapi({
      description:
        "Live share balance. Absent when hydration is unavailable; never coerced to zero.",
    }),
    withdrawableShares: earnLiveDecimalAmountSchema.optional().openapi({
      description: "Live immediately redeemable shares. Absent when hydration is unavailable.",
    }),
    tokenValue: earnLiveDecimalAmountSchema.optional().openapi({
      description: "Live deposit-token value. Absent when hydration is unavailable.",
    }),
  })
  .openapi({ description: "One live vault position owned by a partner end-user wallet." });

const earnExternalWalletTokenTotalSchema = z.object({
  tokenMint: z.string().openapi({ example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  unavailablePositionCount: z.number().int().nonnegative(),
  tokenValue: earnLiveDecimalAmountSchema.optional().openapi({
    description:
      "Exact live total. Absent when any contributing position is unavailable, so partial money is never presented as complete.",
  }),
});

const earnExternalWalletStrategyTotalSchema = z.object({
  provider: z.string().openapi({ example: "kamino" }),
  providerReference: z.string().openapi({
    example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  }),
  label: z.string().openapi({ example: "Allez USDC" }),
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  totalsByToken: z.array(earnExternalWalletTokenTotalSchema),
});

export const earnExternalWalletPositionsResponse = successResponseSchema(
  z.object({
    ownerAddress: earnOwnerAddressSchema,
    positions: z.array(earnExternalWalletPositionSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
);

export const earnExternalWalletPositionSummaryResponse = successResponseSchema(
  z.object({
    summary: z.object({
      walletCount: z.number().int().nonnegative(),
      positionCount: z.number().int().nonnegative(),
      unavailablePositionCount: z.number().int().nonnegative(),
      totalsByStrategy: z.array(earnExternalWalletStrategyTotalSchema),
      totalsByToken: z.array(earnExternalWalletTokenTotalSchema),
    }),
  })
);

export const earnExternalWalletMovementsResponse = successResponseSchema(
  z.object({
    ownerAddress: earnOwnerAddressSchema,
    movements: z.array(earnExternalWalletMovementSchema).openapi({
      description: "The wallet's recorded movements, newest first, in ledger vocabulary.",
    }),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
);

export const earnExternalWalletMovementDetailResponse = successResponseSchema(
  z.object({ movement: earnExternalWalletMovementSchema })
);

const earnSignedDecimalAmountSchema = z
  .string()
  .max(129)
  .regex(/^-?\d+(\.\d+)?$/)
  .openapi({
    description: "Exact decimal figure; a leading '-' marks a genuinely negative value.",
    example: "5.2",
  });

const earnExternalWalletTokenEarningsSchema = z
  .object({
    tokenMint: z.string().openapi({ example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
    positionCount: z.number().int().nonnegative(),
    unavailablePositionCount: z.number().int().nonnegative().openapi({
      description: "Positions whose live value could not hydrate.",
    }),
    currentValue: earnLiveDecimalAmountSchema.optional().openapi({
      description:
        "Live value across the token's positions. Absent when any contributing position is " +
        "unavailable, so partial money is never presented as complete.",
    }),
    totalDeposited: earnLiveDecimalAmountSchema.openapi({
      description: "Sum of finalized SDP deposits — a ledger fact, always present.",
    }),
    earned: earnSignedDecimalAmountSchema.optional().openapi({
      description:
        "`currentValue − totalDeposited`, stated only when exact and never coerced to zero. " +
        "Live hydration reads the owner's whole vault balance, so shares acquired outside SDP " +
        "inflate this figure — a documented property of non-custodial reads.",
    }),
    earnedUnavailableReason: z
      .enum(["live_value_unavailable", "movements_pending", "withdrawals_not_valued"])
      .optional()
      .openapi({
        description:
          "Why `earned` is absent: live value failed to hydrate; a movement is still settling; " +
          "or a currently held position has a finalized withdrawal (the ledger records exits in " +
          "shares, so no exact token-denominated earned figure exists once money has gone out).",
      }),
  })
  .openapi({ description: "Earnings for one deposit token across the wallet's positions." });

export const earnExternalWalletEarningsResponse = successResponseSchema(
  z.object({
    earnings: z.object({
      ownerAddress: earnOwnerAddressSchema,
      positionCount: z.number().int().nonnegative(),
      unavailablePositionCount: z.number().int().nonnegative(),
      totalsByToken: z.array(earnExternalWalletTokenEarningsSchema),
    }),
  })
);
