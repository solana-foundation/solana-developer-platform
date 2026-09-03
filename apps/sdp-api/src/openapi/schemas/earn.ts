import { isoDateTimeSchema, successResponseSchema, z } from "./base";

// ---------------------------------------------------------------------------
// The strategy catalogue: the synced shelf of yield opportunities. Partners
// read it to discover the `strategyId` every deposit build requires and the
// live APY their own UI shows.
// ---------------------------------------------------------------------------

const earnStrategySlippagePolicySchema = z
  .object({
    quoteRequired: z.literal(true).openapi({
      description: "The live quote endpoint must be called before building this direction.",
    }),
    defaultToleranceBps: z
      .number()
      .int()
      .openapi({
        description:
          "Suggested starting tolerance in basis points; the customer may choose another " +
          "accepted value.",
        example: 50,
      }),
  })
  .openapi({
    description:
      "This direction's builder requires a quote-derived protection floor rather than " +
      "accepting an implicit tolerance.",
  });

const earnStrategySchema = z
  .object({
    id: z.string().openapi({
      description: "Catalogue id — the `strategyId` the deposit build takes.",
      example: "earn_strategy_example",
    }),
    provider: z.string().openapi({
      description: "Open provider id (e.g. `kamino`, `veda`).",
      example: "kamino",
    }),
    providerReference: z.string().openapi({
      description: "The instrument's identity at the provider — the vault's on-chain address.",
      example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
    }),
    name: z.string().openapi({ example: "Allez USDC" }),
    sourceKind: z.enum(["defi", "rwa"]).openapi({
      description: "Where the yield comes from: on-chain DeFi or a real-world-asset fund.",
    }),
    underlyingSource: z.string().optional().openapi({
      description: "Open id of the underlying protocol or fund, when the provider reports one.",
      example: "kamino",
    }),
    depositMints: z.array(z.string()).openapi({
      description: "Mints the instrument accepts directly; the FIRST is the deposit token.",
      example: ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
    }),
    shareMint: z.string().optional().openapi({
      description: "The share token a vault-direct deposit mints, when the instrument has one.",
      example: "hXm2xSRF5PLKGMrTvAWqKhR76MuJX5dAabeSChkjqu2",
    }),
    apyType: z.enum(["variable", "fixed"]),
    currentApy: z
      .string()
      .optional()
      .openapi({
        description:
          'Latest observed APY as a decimal ratio string (`"0.062"` = 6.2%), refreshed about ' +
          "every five minutes. Absent when the provider reports none.",
        example: "0.062",
      }),
    liquidityTerm: z.enum(["instant", "delayed"]),
    redemptionDelayDays: z.number().optional().openapi({
      description: "For `delayed` liquidity: the provider's stated redemption delay.",
      example: 2,
    }),
    riskMetadata: z
      .object({
        curator: z.string().optional().openapi({ example: "allez" }),
        riskTier: z.string().optional(),
        frameworkUrl: z.string().optional(),
      })
      .passthrough()
      .optional()
      .openapi({
        description:
          "Curator and risk framework metadata, as published by the provider. Curators " +
          "publish heterogeneous frameworks, so this is an open shape.",
      }),
    status: z.enum(["active", "paused", "deprecated"]).openapi({
      description: "Catalogue lifecycle. Only `active` strategies accept new deposits.",
    }),
    depositSlippage: earnStrategySlippagePolicySchema.nullable().openapi({
      description:
        "Non-null when this provider's deposit builder refuses to run without an explicit " +
        "`minSharesOut`: quote the deposit first and derive the floor from the live figure " +
        "minus a chosen tolerance. Null when the floor is optional.",
    }),
    withdrawalSlippage: earnStrategySlippagePolicySchema.nullable().openapi({
      description:
        "Non-null when this provider's withdrawal builder refuses to run without an explicit " +
        "`minAmountOut`: call the withdrawal preview first and derive the floor from " +
        "`assetsOut`. Null when the floor is optional.",
    }),
    hostCluster: z.enum(["devnet", "mainnet-beta"]).openapi({
      description: "The cluster the INSTRUMENT lives on — a stored fact about the vault.",
    }),
    fundable: z.boolean().openapi({
      description:
        "Whether the instrument exists on the caller's own cluster. `false` is definitive: a " +
        "deposit can never work here. `true` is necessary but NOT sufficient — the strategy " +
        "must also be `active` and the organization entitled to the provider — so branch on " +
        "it rather than assuming a listed strategy takes deposits.",
    }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .openapi({ description: "One synced strategy-catalogue row." });

export const earnStrategiesResponse = successResponseSchema(
  z.object({
    strategies: z.array(earnStrategySchema),
    total: z.number().int().openapi({
      description: "Total rows visible to the caller across all pages.",
      example: 6,
    }),
    page: z.number().int().openapi({ example: 1 }),
    pageSize: z.number().int().openapi({ example: 20 }),
  })
);

export const earnStrategyResponse = successResponseSchema(
  z.object({ strategy: earnStrategySchema })
);

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
      "The external wallet: the customer's own Solana address. It signs and owns the shares; " +
      "SDP holds no key for it. It also pays the network fee unless the build names a " +
      "`feePayer`. The pattern is necessary but not " +
      "sufficient — the string must additionally decode to a 32-byte public key, which no " +
      "pattern can express, so a well-shaped base58 string that does not decode still " +
      "answers 400.",
    example: solanaAddressExample,
  });

const earnFeePayerExample = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";

const earnFeePayerRequestSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .openapi({
    description:
      "Optional: sponsor this transaction from your own wallet instead of the customer's. " +
      "The named address becomes the transaction's fee payer — it pays the network fee, and " +
      "it funds the share-account rent an account creation needs — and the built transaction " +
      "then requires ITS signature alongside the owner's: co-sign server-side with the fee " +
      "payer's key before submitting. The wallet needs a SOL balance; simulation refuses the " +
      "build (400, naming the fee payer) when it cannot pay. Sending the owner's own address " +
      "means the default (the owner pays and signs alone).",
    example: earnFeePayerExample,
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

const earnSolanaMintSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .openapi({
    description: "Base58 Solana mint address.",
    example: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  });

export const earnExternalWalletDepositTransactionRequest = z
  .object({
    strategyId: z.string().min(1).openapi({ example: "earn_strategy_example" }),
    ownerAddress: earnOwnerAddressSchema,
    feePayer: earnFeePayerRequestSchema.optional(),
    amount: earnDecimalAmountSchema.openapi({
      description:
        "Deposit amount as a decimal string — the vault token's units, or the SOURCE token's " +
        "units when `sourceTokenMint` requests a swap-funded build (the swap consumes it " +
        "whole and the vault deposit is sized to the swap's guaranteed output).",
      example: "25",
    }),
    minSharesOut: earnDecimalAmountSchema.optional().openapi({
      description:
        "Slippage floor in share units. Optional in sandbox; required for production deposits.",
      example: "24.9",
    }),
    sourceTokenMint: earnSolanaMintSchema.optional().openapi({
      description:
        "Fund the deposit in a different supported stablecoin (USDC, USDG, PYUSD or USDT on " +
        "the environment's cluster): a Jupiter swap to the vault's own token is prepended " +
        "inside the same transaction, so both legs land atomically or not at all. Equal to " +
        "the strategy's deposit mint it is a no-op, so pickers may always send their " +
        "selection.",
    }),
    swapSlippageBps: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .openapi({
        description:
          "Swap slippage tolerance in basis points (default 2, accepted 1-500). Only valid together with " +
          "sourceTokenMint. The deposit is sized to the swap's worst-case output, so a wider " +
          "tolerance leaves a larger possible remainder of the vault token in the owner's " +
          "account rather than risking the transaction.",
        example: 2,
      }),
  })
  .openapi({ description: "Build one unsigned deposit transaction for an external wallet." });

const earnDepositSwapSchema = z
  .object({
    sourceTokenMint: earnSolanaMintSchema.openapi({
      description: "Mint the owner pays with.",
    }),
    sourceAmount: earnDecimalAmountSchema.openapi({
      description: "What the swap consumes, source-token units.",
    }),
    depositAmount: earnDecimalAmountSchema.openapi({
      description:
        "The deposit amount the transaction encodes, vault-token units — the swap's " +
        "guaranteed worst-case output. Output above it stays in the owner's token account.",
    }),
    quotedAmount: earnDecimalAmountSchema.openapi({
      description: "The swap's quoted output at the live rate, vault-token units.",
    }),
    slippageBps: z.number().int().openapi({ example: 2 }),
    priceImpactPct: z.string().openapi({
      description: "Quoted price impact as a decimal ratio string.",
      example: "0.0001",
    }),
    routeLabels: z.array(z.string()).openapi({
      description: "Venue labels along the quoted route.",
      example: ["Whirlpool"],
    }),
  })
  .openapi({
    description: "The Jupiter swap leg attached to (or split out of) a swap-funded deposit.",
  });

export const earnExternalWalletWithdrawalTransactionRequest = z
  .object({
    positionId: z.string().min(1).max(128).openapi({ example: "earn_position_example" }),
    shares: earnDecimalAmountSchema.openapi({
      description: "Shares to redeem, decimal string in share units.",
      example: "10",
    }),
    minAmountOut: earnDecimalAmountSchema.optional().openapi({
      description:
        "Exit slippage floor: the minimum deposit-token amount to accept, decimal string in " +
        "the token's own units. Derive it from the withdrawal preview's `assetsOut` minus a " +
        "chosen tolerance. Providers whose builder refuses an implicit tolerance (see the " +
        "strategy's `withdrawalSlippage`) answer its absence with a 400.",
      example: "24.9",
    }),
    feePayer: earnFeePayerRequestSchema.optional(),
  })
  .openapi({
    description:
      "Build one unsigned exit transaction for an external-wallet position. The position " +
      "carries the vault and both mints, so a delisted vault stays exitable.",
  });

export const earnExternalWalletWithdrawalPreviewRequest = z
  .object({
    positionId: z.string().min(1).max(128).openapi({ example: "earn_position_example" }),
    shares: earnDecimalAmountSchema.openapi({
      description: "Shares the exit would redeem, decimal string in share units.",
      example: "10",
    }),
  })
  .openapi({
    description:
      "Quote one exit against the vault's live accounting. Read-only: nothing is built and " +
      "nothing is persisted.",
  });

export const earnExternalWalletWithdrawalPreviewResponse = successResponseSchema(
  z.object({
    positionId: z.string().openapi({ example: "earn_position_example" }),
    assetsOut: earnDecimalAmountSchema.openapi({
      description:
        "What redeeming the shares would pay at the live rate, decimal string in the deposit " +
        "token's units — the figure a truthful `minAmountOut` floor is derived from.",
      example: "25.02",
    }),
    assetDecimals: z.number().int().openapi({
      description: "The deposit token's decimals — the scale a floor must be quantized to.",
      example: 6,
    }),
    blockingIssues: z
      .array(
        z.object({
          code: z.string().openapi({ example: "SHARE_LOCKED" }),
          message: z.string(),
        })
      )
      .openapi({
        description: "Conditions the provider reports would block this exit; empty when none.",
      }),
  })
);

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
    feePayer: z
      .string()
      .optional()
      .openapi({
        description:
          "Echo of the build request's `feePayer`. Present, this transaction requires the fee " +
          "payer's signature IN ADDITION to the owner's — co-sign server-side before " +
          "submitting; the submit refuses a missing or invalid fee-payer signature. Absent, " +
          "the owner signs alone and pays the fee.",
        example: earnFeePayerExample,
      }),
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
    swap: earnDepositSwapSchema.optional().openapi({
      description:
        "Present when the build was swap-funded: the swap is prepended inside this same " +
        "transaction and `amount` equals `swap.depositAmount`.",
    }),
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
    minAmountOut: earnDecimalAmountSchema.nullable().openapi({
      description: "The floor encoded in the transaction, or null when the request carried none.",
    }),
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

const earnExternalWalletDepositSwapSplitSchema = z
  .object({
    requiresSeparateSwap: z.literal(true).openapi({
      description: "Discriminates from the atomic answer, which carries `transaction`.",
    }),
    swap: earnDepositSwapSchema.extend({
      transaction: z.string().openapi({
        description:
          "Base64 wire bytes of the UNSIGNED swap-only transaction. The fee payer is the " +
          "owner, or the original request's `feePayer` (which then co-signs this transaction " +
          "too). The partner broadcasts it itself — it moves only the owner's own funds, so " +
          "SDP records nothing for it.",
      }),
      lastValidBlockHeight: z.string().openapi({ example: "361186610" }),
    }),
    followUp: z
      .object({
        strategyId: z.string().openapi({ example: "earn_strategy_example" }),
        amount: earnDecimalAmountSchema,
        minSharesOut: earnDecimalAmountSchema.optional().openapi({
          description:
            "The original request's share floor, carried through so the follow-up build " +
            "keeps the protection the caller asked for. Absent only when the original " +
            "request carried none.",
        }),
        feePayer: z
          .string()
          .optional()
          .openapi({
            description:
              "The original request's fee payer, carried through so the follow-up build does " +
              "not silently bill the customer's wallet. Absent when none was named.",
            example: earnFeePayerExample,
          }),
      })
      .openapi({
        description:
          "The ordinary (unswapped) deposit build to request once the swap is confirmed.",
      }),
  })
  .openapi({
    description:
      "Answered instead of a built transaction when the composed swap + deposit cannot fit " +
      "one Solana packet (1,232 bytes) even on a compact route. Nothing was persisted.",
  });

export const earnExternalWalletDepositTransactionResponse = successResponseSchema(
  z.union([
    z.object({ transaction: earnExternalWalletDepositTransactionSchema }),
    earnExternalWalletDepositSwapSplitSchema,
  ])
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
  ownerAddresses: z.array(earnOwnerAddressSchema).openapi({
    description: "The exact project-scoped owners contributing to this strategy total.",
  }),
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
