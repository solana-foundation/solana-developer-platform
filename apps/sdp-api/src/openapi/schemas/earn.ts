import { EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS } from "@sdp/types/earn";
import { z } from "zod";
import {
  errorResponseSchema,
  isoDateTimeSchema,
  successResponseSchema,
} from "@/openapi/schemas/base";
import {
  EARN_CANCEL_TRANSACTION_REQUEST_EXAMPLE,
  EARN_DEPOSIT_PREVIEW_EXAMPLE,
  EARN_DEPOSIT_PREVIEW_REQUEST_EXAMPLE,
  EARN_DEPOSIT_SUBMIT_EXAMPLE,
  EARN_DEPOSIT_TRANSACTION_EXAMPLE,
  EARN_DEPOSIT_TRANSACTION_REQUEST_EXAMPLE,
  EARN_EARNINGS_EXAMPLE,
  EARN_EXAMPLE_IDS,
  EARN_MOVEMENT_FINALIZED_EXAMPLE,
  EARN_MOVEMENTS_EXAMPLE,
  EARN_OWNER_ADDRESS_EXAMPLE,
  EARN_POSITION_SUMMARY_EXAMPLE,
  EARN_POSITIONS_EXAMPLE,
  EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE,
  EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
  EARN_STRATEGY_EXAMPLE,
  EARN_WITHDRAWAL_OPTIONS_EXAMPLE,
  EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_PREVIEW_EXAMPLE,
  EARN_WITHDRAWAL_PREVIEW_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_CANCEL_TRANSACTION_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_CANCELLING_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_TRANSACTION_EXAMPLE,
  EARN_WITHDRAWAL_REQUESTS_EXAMPLE,
  EARN_WITHDRAWAL_SUBMIT_EXAMPLE,
  EARN_WITHDRAWAL_TRANSACTION_EXAMPLE,
  EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE,
} from "@/openapi/schemas/earn-examples";

/** A missing Earn provider capability, returned by SdpEarnError rather than AppError. */
export const earnNotImplementedErrorResponseSchema = errorResponseSchema.extend({
  error: errorResponseSchema.shape.error.extend({ code: z.literal("NOT_IMPLEMENTED") }),
});

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
          "Suggested tolerance in basis points, to take off a preview's quote when you " +
          "compute the floor. Your customer may choose another.",
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
      description: "The strategy's ID. Pass it as `strategyId` to preview or build a " + "deposit.",
      example: EARN_EXAMPLE_IDS.strategy,
    }),
    provider: z.string().openapi({
      description: "Open provider id (e.g. `kamino`, `veda`).",
      example: "kamino",
    }),
    providerReference: z.string().openapi({
      description:
        "The strategy's onchain address at the provider, such as a vault. It " +
        "identifies the instrument; never send funds to it.",
      example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
    }),
    name: z.string().openapi({ example: "Allez USDC" }),
    sourceKind: z.enum(["defi", "rwa"]).openapi({
      description: "Where the yield comes from: onchain DeFi or real-world assets.",
    }),
    underlyingSource: z.string().optional().openapi({
      description: "Open id of the underlying protocol or fund, when the provider reports one.",
      example: "kamino",
    }),
    depositMints: z.array(z.string()).openapi({
      description: "Mints the strategy accepts directly. The first is the deposit token.",
      example: ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
    }),
    shareMint: z.string().optional().openapi({
      description: "The share token a deposit mints, when the strategy has one.",
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
      description: "The strategy's lifecycle. Only `active` strategies accept new " + "deposits.",
    }),
    depositSlippage: earnStrategySlippagePolicySchema.nullable().openapi({
      description:
        "Not null when a deposit build for this strategy, in your environment, " +
        "requires `minSharesOut`. Preview the deposit first and derive the " +
        "floor from `sharesOut` minus your tolerance. Most production " +
        "strategies are not null; a strategy priced later, such as a provider " +
        "order, may be null because no onchain instruction can enforce a floor. " +
        "Answered per request, like `fundable`.",
    }),
    withdrawalSlippage: earnStrategySlippagePolicySchema.nullable().openapi({
      description:
        "Non-null when this provider's withdrawal builder refuses to run without an explicit " +
        "`minAmountOut`: call the withdrawal preview first and derive the floor from " +
        "`assetsOut`. Null when this withdrawal cannot enforce a floor; omit `minAmountOut`.",
    }),
    hostCluster: z.enum(["devnet", "mainnet-beta"]).openapi({
      description: "The cluster the strategy runs on.",
    }),
    fundable: z.boolean().openapi({
      description:
        "Whether the strategy exists on your project's cluster. `false` means a " +
        "deposit can never work from this project. `true` is necessary but not " +
        "sufficient: the strategy must also be `active`, and your organization " +
        "must be activated for the provider.",
    }),
    feeSponsored: z.boolean().openapi({
      description:
        "Whether SDP pays network fees for Treasury movements on this strategy " +
        "from your environment. It never applies to a customer's wallet: to " +
        "sponsor an Embedded Yield transaction, pass `feePayer` when you build " +
        "it. Always `false` when the strategy is not `fundable`, and a " +
        "swap-funded deposit is never sponsored.",
    }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .openapi({ description: "One strategy in the catalog.", example: EARN_STRATEGY_EXAMPLE });

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
// unsigned transaction for a wallet it does not custody, and the caller submits
// it back for durable tracking and SDP broadcast.
// ---------------------------------------------------------------------------

const solanaAddressExample = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** The customer's wallet on a response: SDP wrote it, so no request rules apply. */
const earnOwnerAddressFieldSchema = z.string().openapi({
  description: "The customer's wallet address.",
  example: EARN_OWNER_ADDRESS_EXAMPLE,
});

const earnOwnerAddressSchema = z
  .string()
  .min(32)
  .max(44)
  // Base58 shape, matching the runtime's trim + isAddress refusal.
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .openapi({
    description:
      "The customer's wallet address: an external wallet, so SDP holds no key " +
      "for it. It signs, owns the shares, and pays the network fee unless the " +
      "build names a `feePayer`. It must decode to a 32-byte public key; a " +
      "base58 string that matches the pattern but does not decode returns " +
      "400.",
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
      "Pay for this transaction from a wallet your backend controls instead " +
      "of the customer's. The named address becomes the fee payer: it pays " +
      "the network fee, funds any share-account rent, and must sign alongside " +
      "the customer. Co-sign on your backend before you submit. The build " +
      "returns 400, naming the fee payer, when it cannot pay. Sending the " +
      "customer's own address keeps the default: the customer pays and signs " +
      "alone.",
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
    strategyId: z.string().min(1).openapi({ example: EARN_EXAMPLE_IDS.strategy }),
    ownerAddress: earnOwnerAddressSchema,
    feePayer: earnFeePayerRequestSchema.optional(),
    amount: earnDecimalAmountSchema.openapi({
      description:
        "The deposit amount as a decimal string, in deposit-token units. For a " +
        "swap-funded build (`sourceTokenMint`), it is in source-token units " +
        "instead: the swap spends all of it, and the deposit is sized to the " +
        "swap's guaranteed output.",
      example: "25",
    }),
    minSharesOut: earnDecimalAmountSchema.optional().openapi({
      description:
        "Slippage floor in share units. Required exactly when the selected strategy's " +
        "`depositSlippage` is non-null. Derive it " +
        "from `POST /v1/earn/vault-deposit-previews`, never from the deposit amount.",
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
          "Swap slippage tolerance in basis points (default 2, accepted 1-500). " +
          "Valid only with `sourceTokenMint`. The deposit is sized to the swap's " +
          "worst-case output, so a wider tolerance can leave more of the deposit " +
          "token in the customer's account instead of failing the transaction.",
        example: 2,
      }),
  })
  .openapi({ description: "Build one unsigned deposit transaction for an external wallet." })
  .openapi({ example: EARN_DEPOSIT_TRANSACTION_REQUEST_EXAMPLE });

const earnDepositSwapSchema = z
  .object({
    sourceTokenMint: earnSolanaMintSchema.openapi({
      description: "Mint the owner pays with.",
    }),
    sourceAmount: earnDecimalAmountSchema.openapi({
      description: "What the swap spends, in source-token units.",
    }),
    depositAmount: earnDecimalAmountSchema.openapi({
      description:
        "The deposit amount the transaction encodes, in deposit-token units: " +
        "the swap's guaranteed minimum output. Any output above it stays in the " +
        "customer's token account.",
    }),
    quotedAmount: earnDecimalAmountSchema.openapi({
      description: "The swap's quoted output at the live rate, in deposit-token units.",
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

const earnExternalWalletPositionLocatorSchema = z.object({
  positionId: z
    .string()
    .min(1)
    .max(128)
    .openapi({
      description:
        "The position's ID, from the positions list or the deposit submit " + "response.",
      example: EARN_EXAMPLE_IDS.position,
    }),
});

const earnExternalWalletWithdrawalFields = {
  shares: earnDecimalAmountSchema.openapi({
    description: "Shares to redeem, decimal string in share units.",
    example: "10",
  }),
  minAmountOut: earnDecimalAmountSchema.optional().openapi({
    description:
      "Withdrawal slippage floor: the minimum deposit-token amount to accept, as a " +
      "decimal string. Derive it from the withdrawal preview's `assetsOut` minus your " +
      "tolerance. Required when the strategy's `withdrawalSlippage` is not null; refused " +
      "with 400 when it is null, because the transaction cannot enforce it.",
    example: "19.98",
  }),
  feePayer: earnFeePayerRequestSchema.optional(),
} as const;

export const earnExternalWalletWithdrawalTransactionRequest =
  earnExternalWalletPositionLocatorSchema
    .extend(earnExternalWalletWithdrawalFields)
    .openapi({
      description:
        "Build one unsigned withdrawal transaction for a position. SDP reads " +
        "the strategy and mints from the position.",
    })
    .openapi({ example: EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE });

const earnExternalWalletWithdrawalPreviewFields = {
  shares: earnDecimalAmountSchema.openapi({
    description:
      "Shares to withdraw, as a decimal string in share units. Keep it within the " +
      "position's `withdrawableShares`: the preview does not check the balance.",
    example: "10",
  }),
} as const;

export const earnExternalWalletWithdrawalPreviewRequest = earnExternalWalletPositionLocatorSchema
  .extend(earnExternalWalletWithdrawalPreviewFields)
  .openapi({
    description:
      "Quote one withdrawal from a position against the strategy's live " +
      "accounting. Read-only: nothing is built or saved.",
  })
  .openapi({ example: EARN_WITHDRAWAL_PREVIEW_REQUEST_EXAMPLE });

const earnVaultQuoteIssueSchema = z.object({
  code: z.string().openapi({ example: "SHARE_LOCKED" }),
  message: z.string(),
});

export const earnVaultDepositPreviewRequest = z
  .object({
    strategyId: z.string().min(1).openapi({ example: EARN_EXAMPLE_IDS.strategy }),
    amount: earnDecimalAmountSchema.openapi({
      description: "Deposit amount in deposit-token units.",
      example: "25",
    }),
  })
  .openapi({
    description:
      "Quote one direct vault deposit against the provider's live accounting. Read-only: " +
      "nothing is built and nothing is persisted.",
  })
  .openapi({ example: EARN_DEPOSIT_PREVIEW_REQUEST_EXAMPLE });

export const earnVaultDepositPreviewResponse = successResponseSchema(
  z
    .object({
      strategyId: z.string().openapi({ example: EARN_EXAMPLE_IDS.strategy }),
      sharesOut: earnDecimalAmountSchema.openapi({
        description:
          "Shares the deposit would mint at the live rate. Derive `minSharesOut` from this " +
          "value minus the chosen tolerance, quantized to `shareDecimals`.",
        example: "24.98",
      }),
      shareDecimals: z.number().int().openapi({
        description: "The share mint's decimals, which the floor must be quantized to.",
        example: 6,
      }),
      blockingIssues: z.array(earnVaultQuoteIssueSchema).openapi({
        description: "Conditions the provider reports would block this deposit; empty when none.",
      }),
      feeSponsored: z.boolean().openapi({
        description:
          "Whether SDP pays network fees for Treasury movements on this cluster. " +
          "It does not apply to customer wallets: to sponsor an Embedded Yield " +
          "transaction, pass `feePayer` when you build it.",
      }),
    })
    .openapi({ example: EARN_DEPOSIT_PREVIEW_EXAMPLE })
);

export const earnVaultShareReconciliationResponse = successResponseSchema(
  z.object({
    unrecordedHoldings: z
      .array(
        z.object({
          custodyWalletId: z.string().openapi({ example: "cwlt_example" }),
          walletAddress: z
            .string()
            .openapi({ example: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }),
          provider: z.string().openapi({ example: "kamino" }),
          strategyId: z.string().openapi({ example: EARN_EXAMPLE_IDS.strategy }),
          strategyName: z.string().openapi({ example: "USDC Prime Vault" }),
          vaultAddress: z.string().openapi({
            description: "The cataloged vault the held share mint belongs to.",
          }),
          shareMint: z.string(),
          shares: z.string().openapi({
            description: "Raw share-token amount in base units.",
            example: "500",
          }),
          decimals: z.number().int().openapi({ example: 6 }),
          uiShares: z.string().openapi({ example: "0.0005" }),
          ambiguousAttribution: z.boolean().openapi({
            description:
              "True when more than one cataloged vault claims this share mint, so the " +
              "match is the best candidate rather than the only one.",
          }),
        })
      )
      .openapi({
        description:
          "Share balances the custody wallet holds for cataloged vaults with no " +
          "recorded open position behind them, such as shares acquired by signing " +
          "outside SDP.",
      }),
    unbackedPositions: z
      .array(
        z.object({
          positionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
          custodyWalletId: z.string().openapi({ example: "cwlt_example" }),
          walletAddress: z.string(),
          provider: z.string().openapi({ example: "kamino" }),
          vaultAddress: z.string().nullable(),
          shareMint: z.string().nullable(),
          label: z.string(),
          ambiguousBacking: z.boolean().openapi({
            description:
              "True when the wallet holds intermediate tokens this position's cancelled operator " +
              "redemption may have left, but an unresolved request or another position's " +
              "redemption could own them, so the report cannot tell whether they back it.",
          }),
        })
      )
      .openapi({
        description:
          "Recorded open positions whose wallet holds none of their shares. Positions with an " +
          "unsettled movement are excluded: the ledger already explains that disagreement. " +
          "So is a position provably backed by the intermediate token its cancelled operator " +
          "redemption left in place of its shares; one whose backing the report cannot decide " +
          "carries `ambiguousBacking`. Positions with an open queued withdrawal request are " +
          "listed in `queuedWithdrawalPositions` instead.",
      }),
    queuedWithdrawalPositions: z
      .array(
        z.object({
          positionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
          custodyWalletId: z.string().openapi({ example: "cwlt_example" }),
          walletAddress: z.string(),
          provider: z.string().openapi({ example: "veda" }),
          vaultAddress: z.string().nullable(),
          shareMint: z.string().nullable(),
          label: z.string(),
          ambiguousBacking: z.boolean().openapi({
            description:
              "True when the wallet holds intermediate tokens this position's cancelled operator " +
              "redemption may have left, but an unresolved request or another position's " +
              "redemption could own them, so the report cannot tell whether they back it.",
          }),
          withdrawalRequestIds: z.array(z.string()).openapi({
            example: [EARN_EXAMPLE_IDS.withdrawalRequest],
          }),
        })
      )
      .openapi({
        description:
          "Recorded open positions whose wallet holds none of their shares while queued " +
          "withdrawal requests are open. The requests escrowed or burned shares ahead of the " +
          "payout, but only the shares they cover, so these positions are listed with their " +
          "requests rather than judged. A position provably backed by its cancelled operator " +
          "redemption's intermediate token is omitted from both lists.",
      }),
    unreadableWallets: z
      .array(
        z.object({
          custodyWalletId: z.string().openapi({ example: "cwlt_example" }),
          walletAddress: z.string(),
        })
      )
      .openapi({
        description:
          "Wallets whose balance read failed or ran out of the request budget. Their claims " +
          "are unjudged in this report, never closed or marked unbacked.",
      }),
  })
);

export const earnExternalWalletWithdrawalPreviewResponseFields = {
  assetsOut: earnDecimalAmountSchema.openapi({
    description:
      "What redeeming the shares would pay at the live rate, decimal string in the deposit " +
      "token's units. A truthful `minAmountOut` floor is derived from this figure.",
    example: "25.02",
  }),
  assetDecimals: z.number().int().openapi({
    description: "The deposit token's decimals, which define the scale used to quantize a floor.",
    example: 6,
  }),
  blockingIssues: z.array(earnVaultQuoteIssueSchema).openapi({
    description: "Conditions the provider reports would block this withdrawal; empty when none.",
  }),
} as const;

export const earnExternalWalletWithdrawalPreviewResponse = successResponseSchema(
  earnExternalWalletPositionLocatorSchema
    .extend(earnExternalWalletWithdrawalPreviewResponseFields)
    .openapi({ example: EARN_WITHDRAWAL_PREVIEW_EXAMPLE })
);

const earnAsyncWithdrawalSharesSchema = earnDecimalAmountSchema.openapi({
  description: "Shares to place in the withdrawal request, in share units.",
  example: "10",
});

/** An operator redemption over held intermediate burns no shares. */
const earnParRedemptionSharesSchema = z
  .string()
  .max(128)
  .regex(/^\d+(\.\d+)?$/)
  .openapi({
    description:
      'Position shares the request burns, in share units; "0" when it redeems intermediate the owner already holds.',
    example: "10",
  });

const earnQueuedWithdrawalTermsFields = {
  shares: earnAsyncWithdrawalSharesSchema,
  mechanism: z
    .literal("solverQueue")
    .optional()
    .openapi({
      description:
        "Selects the solver queue, which is also the default when omitted. " +
        "Operator redemptions must set `mechanism` explicitly.",
    }),
  discountBps: z.number().int().min(0).max(10_000).openapi({
    description:
      "Discount offered to a solver, in basis points. It must stay inside the live queueAsset minimum and maximum.",
    example: 25,
  }),
  deadlineSeconds: z
    .number()
    .int()
    .positive()
    .max(EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS)
    .openapi({
      description:
        "Solver window after maturity, in seconds. It must stay inside the live queueAsset minimum and maximum.",
      example: 86_400,
    }),
} as const;

const earnQueuedWithdrawalAssetSchema = z.object({
  assetMint: earnSolanaMintSchema,
  allowWithdrawals: z.boolean().openapi({
    description: "Whether this asset's queue currently accepts new requests.",
  }),
  secondsToMaturity: z
    .number()
    .int()
    .nonnegative()
    .openapi({
      description:
        "Seconds after the request is created, by the cluster clock, before a solver may " +
        "fulfill it.",
      example: 86_400,
    }),
  minimumSecondsToDeadline: z.number().int().nonnegative().openapi({
    description: "Shortest solver window accepted after maturity.",
    example: 3_600,
  }),
  maximumSecondsToDeadline: z
    .number()
    .int()
    .positive()
    .max(EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS)
    .openapi({
      description: "Longest solver window accepted after maturity.",
      example: EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS,
    }),
  minimumDiscountBps: z.number().int().min(0).max(10_000).openapi({ example: 0 }),
  maximumDiscountBps: z.number().int().min(0).max(10_000).openapi({ example: 500 }),
  minimumShares: earnDecimalAmountSchema.openapi({
    description: "Smallest request accepted by the queue, in share units.",
    example: "1",
  }),
  shareDecimals: z.number().int().min(0).max(38).openapi({ example: 6 }),
});

const earnParRedemptionOptionsSchema = z.object({
  intermediateMint: earnSolanaMintSchema.openapi({
    description:
      "Token created or delegated by the request transaction and later burned by the operator.",
  }),
  assetMint: earnSolanaMintSchema.openapi({
    description: "Token the operator pays when the redemption completes.",
  }),
  minimumShares: earnDecimalAmountSchema.nullable().openapi({
    description:
      "Smallest operator redemption request funded by shares, in " +
      "position-share units. Null while the provider's rate is unavailable, " +
      "which also blocks share-funded requests.",
    example: "1",
  }),
  minimumIntermediateAmount: earnDecimalAmountSchema.openapi({
    description:
      "Smallest request over intermediate the owner already holds, in intermediate-token units.",
    example: "0.000001",
  }),
  shareDecimals: z.number().int().min(0).max(38).openapi({ example: 6 }),
  assetDecimals: z.number().int().min(0).max(38).openapi({ example: 6 }),
  cancelable: z.boolean().openapi({
    description: "Whether the owner may revoke an open request before the operator completes it.",
  }),
  operatorSettled: z.literal(true).openapi({
    description: "Always true: a provider operator must complete the eventual asset payout.",
  }),
});

export const earnQueuedWithdrawalOptionsFields = {
  instant: z.boolean().openapi({
    description:
      "Whether the withdrawal endpoints build an instant withdrawal for this position. " +
      "Never true together with `providerOrder`.",
  }),
  providerOrder: z.boolean().openapi({
    description:
      "Whether the withdrawal endpoints build a provider order that pays out later. " +
      "Never true together with `instant`.",
  }),
  queued: z.boolean().openapi({
    description:
      "Whether a solver queue accepts requests now. Never infer it from `liquidityTerm`.",
  }),
  withdrawAuthority: z
    .string()
    .nullable()
    .openapi({
      description:
        "The withdrawal authority the queue's vault reports, or null without a queue. " +
        "Informational: no request takes it.",
    }),
  queueState: z.string().nullable().openapi({
    description: "The provider queue account, or null without a queue.",
  }),
  queueAsset: earnQueuedWithdrawalAssetSchema.nullable().openapi({
    description:
      "Live asset-specific queue limits. Null when this asset has no queue configuration.",
  }),
  parRedemption: earnParRedemptionOptionsSchema.nullable().openapi({
    description:
      "Live operator redemption terms. Null when this strategy offers no operator " + "redemption.",
  }),
} as const;

const earnParRedemptionTermsFields = {
  shares: earnAsyncWithdrawalSharesSchema,
  mechanism: z.literal("operatorRedemption").openapi({
    description: "Selects an operator redemption, which takes no solver discount or deadline.",
  }),
} as const;

const earnParRedemptionIntermediateTermsFields = {
  intermediateAmount: earnDecimalAmountSchema.openapi({
    description:
      "Intermediate token the owner already holds outside any request (such as a cancelled request's wYLDS) to redeem at par, in that token's units. Send instead of `shares`, never with it.",
    example: "2000",
  }),
  mechanism: earnParRedemptionTermsFields.mechanism,
} as const;

export const earnExternalWalletWithdrawalOptionsRequest = earnExternalWalletPositionLocatorSchema
  .openapi({
    description: "List the withdrawal routes a position supports right now.",
  })
  .openapi({ example: EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE });

export const earnExternalWalletWithdrawalOptionsResponse = successResponseSchema(
  earnExternalWalletPositionLocatorSchema
    .extend(earnQueuedWithdrawalOptionsFields)
    .openapi({ example: EARN_WITHDRAWAL_OPTIONS_EXAMPLE })
);

export const earnExternalWalletQueuedWithdrawalPreviewRequest = z
  .union([
    earnExternalWalletPositionLocatorSchema.extend(earnQueuedWithdrawalTermsFields),
    earnExternalWalletPositionLocatorSchema.extend(earnParRedemptionTermsFields),
    earnExternalWalletPositionLocatorSchema.extend(earnParRedemptionIntermediateTermsFields),
  ])
  .openapi({
    description:
      "Preview a solver-queue or operator-redemption request against live provider limits. Read-only: nothing is built or persisted.",
  })
  .openapi({ example: EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE });

export const earnQueuedWithdrawalPreviewFields = {
  assetMint: earnSolanaMintSchema,
  shares: earnDecimalAmountSchema,
  shareDecimals: z.number().int().min(0).max(38),
  assets: earnDecimalAmountSchema.openapi({
    description: "Expected payout after the discount, in `assetMint` units.",
    example: "9.975",
  }),
  assetDecimals: z.number().int().min(0).max(38),
  discountBps: z.number().int().min(0).max(10_000),
  maturityTimestamp: z.string().regex(/^\d+$/).openapi({
    description: "Unix time, in seconds, when a solver may start fulfilling the request.",
    example: "1789722000",
  }),
  deadlineTimestamp: z
    .string()
    .regex(/^\d+$/)
    .openapi({
      description:
        "Unix time, in seconds, of the request's deadline. A solver may fulfill " +
        "it until this time; cancellation is allowed only after it.",
      example: "1789808400",
    }),
  blockingIssues: z.array(earnVaultQuoteIssueSchema),
} as const;

export const earnParRedemptionPreviewFields = {
  mechanism: z.literal("operatorRedemption"),
  shares: earnParRedemptionSharesSchema,
  shareDecimals: z.number().int().min(0).max(38),
  intermediateMint: earnSolanaMintSchema.openapi({
    description: "Token the request creates or delegates for later operator settlement.",
  }),
  intermediateAmount: earnDecimalAmountSchema.openapi({
    description: "Expected intermediate-token amount, in that token's units.",
  }),
  assetMint: earnSolanaMintSchema,
  assets: earnDecimalAmountSchema.openapi({
    description: "Expected par payout when the operator completes the redemption.",
    example: "10",
  }),
  assetDecimals: z.number().int().min(0).max(38),
  blockingIssues: z.array(earnVaultQuoteIssueSchema),
} as const;

export const earnExternalWalletQueuedWithdrawalPreviewResponse = successResponseSchema(
  z
    .union([
      earnExternalWalletPositionLocatorSchema.extend(earnQueuedWithdrawalPreviewFields),
      earnExternalWalletPositionLocatorSchema.extend(earnParRedemptionPreviewFields),
    ])
    .openapi({ example: EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE })
);

export const earnExternalWalletWithdrawalRequestTransactionRequest = z
  .union([
    earnExternalWalletPositionLocatorSchema.extend({
      ...earnQueuedWithdrawalTermsFields,
      feePayer: earnFeePayerRequestSchema.optional(),
    }),
    earnExternalWalletPositionLocatorSchema.extend({
      ...earnParRedemptionTermsFields,
      feePayer: earnFeePayerRequestSchema.optional(),
    }),
    earnExternalWalletPositionLocatorSchema.extend({
      ...earnParRedemptionIntermediateTermsFields,
      feePayer: earnFeePayerRequestSchema.optional(),
    }),
  ])
  .openapi({
    description:
      "Build a keyed asynchronous withdrawal request. A solver request escrows shares; an operator redemption converts them into the provider's intermediate token, or delegates intermediate the owner already holds. Neither action pays assets.",
  })
  .openapi({ example: EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE });

export const earnExternalWalletWithdrawalRequestCancelTransactionRequest = z
  .object({
    withdrawalRequestId: z.string().min(1).max(128).openapi({
      example: EARN_EXAMPLE_IDS.withdrawalRequest,
    }),
    feePayer: earnFeePayerRequestSchema.optional(),
  })
  .openapi({
    description:
      "Build a cancellation for the customer's wallet to sign. A solver queue request " +
      "becomes cancelable at `expiredCancelable`; an operator redemption that allows " +
      "cancellation can be canceled while `pending`.",
  })
  .openapi({ example: EARN_CANCEL_TRANSACTION_REQUEST_EXAMPLE });

const earnQueuedWithdrawalStatusSchema = z
  .enum([
    "creating",
    "pending",
    "fulfillable",
    "expiredCancelable",
    "cancelling",
    "fulfilled",
    "cancelled",
    "closedOrUnknown",
    "failed",
  ])
  .openapi({
    description:
      "The request's status. Only `fulfilled`, `cancelled` and `failed` are final. " +
      "Keep tracking every other status, `closedOrUnknown` included: SDP resolves it " +
      "from a finalized close event.",
  });

const earnAsyncWithdrawalRequestCommonFields = {
  withdrawalRequestId: z.string().openapi({ example: EARN_EXAMPLE_IDS.withdrawalRequest }),
  positionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
  provider: z.string().openapi({ example: "veda" }),
  providerReference: z.string().openapi({ description: "The strategy's onchain address." }),
  ownerAddress: earnOwnerAddressFieldSchema,
  requestAddress: z.string().openapi({ description: "Provider request account address." }),
  status: earnQueuedWithdrawalStatusSchema,
  assetMint: earnSolanaMintSchema,
  shareMint: earnSolanaMintSchema,
  shares: earnDecimalAmountSchema,
  quotedAssets: earnDecimalAmountSchema.openapi({
    description:
      "Expected payout at request creation, in `assetMint` units. Not a settled " + "amount.",
  }),
  shareDecimals: z.number().int().min(0).max(38),
  assetDecimals: z.number().int().min(0).max(38),
  nonce: z.string().nullable(),
  creationTimestamp: z.string().regex(/^\d+$/).nullable(),
  creationSignature: z.string().nullable().openapi({
    description: "The request-creation transaction. Its confirmation does not prove a payout.",
  }),
  cancelSignature: z.string().nullable().openapi({
    description: "The cancellation transaction, once one is submitted.",
  }),
  closingSignature: z.string().nullable().openapi({
    description: "Provider-authenticated fulfillment or cancellation transaction, when known.",
  }),
  assetsPaid: earnDecimalAmountSchema.nullable().openapi({
    description: "The payout SDP observed at fulfillment, in `assetMint` units; null until then.",
  }),
  failureReason: z.string().nullable(),
  fulfilledAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  replayed: z.boolean().optional(),
} as const;

const earnSolverWithdrawalRequestSchema = z.object({
  ...earnAsyncWithdrawalRequestCommonFields,
  mechanism: z.literal("solverQueue"),
  intermediateMint: z.null(),
  intermediateAmount: z.null(),
  discountBps: z.number().int().min(0).max(10_000),
  maturityTimestamp: z.string().regex(/^\d+$/),
  deadlineTimestamp: z.string().regex(/^\d+$/),
});

const earnOperatorRedemptionRequestSchema = z.object({
  ...earnAsyncWithdrawalRequestCommonFields,
  shares: earnParRedemptionSharesSchema,
  mechanism: z.literal("operatorRedemption"),
  intermediateMint: earnSolanaMintSchema,
  intermediateAmount: earnDecimalAmountSchema,
  discountBps: z.null(),
  maturityTimestamp: z.null(),
  deadlineTimestamp: z.null(),
});

const earnAsyncWithdrawalRequestSchema = z.union([
  earnSolverWithdrawalRequestSchema,
  earnOperatorRedemptionRequestSchema,
]);

export const earnExternalWalletWithdrawalRequestResponse = successResponseSchema(
  z
    .object({ withdrawalRequest: earnAsyncWithdrawalRequestSchema })
    .openapi({ example: EARN_WITHDRAWAL_REQUEST_EXAMPLE })
);

/** The same body as a request read, shown as it looks right after a cancellation submit. */
export const earnExternalWalletWithdrawalRequestCancellationResponse = successResponseSchema(
  z
    .object({ withdrawalRequest: earnAsyncWithdrawalRequestSchema })
    .openapi({ example: EARN_WITHDRAWAL_REQUEST_CANCELLING_EXAMPLE })
);

export const earnExternalWalletWithdrawalRequestsResponse = successResponseSchema(
  z
    .object({
      withdrawalRequests: z.array(earnAsyncWithdrawalRequestSchema),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    })
    .openapi({ example: EARN_WITHDRAWAL_REQUESTS_EXAMPLE })
);

export const earnExternalWalletSubmitRequest = z
  .object({
    transactionId: z.string().min(1).max(128).openapi({
      description: "The built transaction being submitted; single-use.",
      example: EARN_EXAMPLE_IDS.depositBuild,
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
      "same key resolves the original movement or withdrawal request instead of acting twice.",
  });

const earnExternalWalletTransactionSchema = z
  .object({
    transactionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.depositBuild }),
    transaction: z.string().openapi({
      description:
        "Base64 wire bytes of the unsigned transaction. Add every required signature without " +
        "changing the message, then submit through SDP. The blockhash bounds when the network " +
        "can first accept it; retain the original signed bytes for recovery.",
    }),
    lastValidBlockHeight: z.string().openapi({
      description:
        "Last block height at which the network can first accept this transaction. This is " +
        "a block height, not a slot or timestamp.",
      example: "361186610",
    }),
    sponsored: z.boolean().openapi({
      description:
        "Always false: SDP does not pay an external wallet's fees. The customer's " +
        "wallet pays, or the `feePayer` you name.",
      example: false,
    }),
    ownerAddress: earnOwnerAddressFieldSchema,
    feePayer: z
      .string()
      .optional()
      .openapi({
        description:
          "The `feePayer` your build request named. When present, the transaction " +
          "needs the fee payer's signature as well as the customer's: co-sign on " +
          "your backend before you submit, or the submit refuses it. When absent " +
          "or null, the customer signs alone and pays the fee.",
        example: earnFeePayerExample,
      }),
    provider: z.string().openapi({ example: "kamino" }),
    providerReference: z.string().openapi({
      description:
        "The strategy's onchain address at the provider. It identifies the " +
        "instrument; never send funds to it.",
      example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
    }),
    tokenMint: z.string().openapi({ example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
    shareMint: z.string().openapi({ example: "hXm2xSRF5PLKGMrTvAWqKhR76MuJX5dAabeSChkjqu2" }),
  })
  .openapi({ description: "One unsigned transaction SDP built for an external wallet to sign." });

const earnQueuedWithdrawalRequestBuildSchema = earnExternalWalletTransactionSchema
  .extend({
    positionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
    action: z.literal("request"),
    mechanism: z.literal("solverQueue"),
    requestAddress: z.string().openapi({ description: "Provider request account address." }),
    shares: earnDecimalAmountSchema,
    assets: earnDecimalAmountSchema,
    discountBps: z.number().int().min(0).max(10_000),
    maturityTimestamp: z.string().regex(/^\d+$/),
    deadlineTimestamp: z.string().regex(/^\d+$/),
  })
  .openapi({ description: "A solver queue request for the customer's wallet to sign." });

const earnOperatorRedemptionRequestBuildSchema = earnExternalWalletTransactionSchema
  .extend({
    positionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
    action: z.literal("request"),
    mechanism: z.literal("operatorRedemption"),
    requestAddress: z.string().openapi({ description: "Provider request account address." }),
    shares: earnParRedemptionSharesSchema,
    assets: earnDecimalAmountSchema,
    intermediateMint: earnSolanaMintSchema,
    intermediateAmount: earnDecimalAmountSchema,
  })
  .openapi({ description: "An operator redemption request for the customer's wallet to sign." });

const earnQueuedWithdrawalCancelBuildSchema = earnExternalWalletTransactionSchema
  .extend({
    positionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
    withdrawalRequestId: z.string().openapi({
      example: EARN_EXAMPLE_IDS.withdrawalRequest,
    }),
    action: z.literal("cancel"),
    mechanism: z.enum(["solverQueue", "operatorRedemption"]),
    requestAddress: z.string().openapi({ description: "Provider request account address." }),
  })
  .openapi({ description: "A cancellation for the customer's wallet to sign." });

/** A request build answers only request transactions. */
export const earnExternalWalletWithdrawalRequestTransactionResponse = successResponseSchema(
  z
    .object({
      transaction: z.union([
        earnQueuedWithdrawalRequestBuildSchema,
        earnOperatorRedemptionRequestBuildSchema,
      ]),
    })
    .openapi({ example: EARN_WITHDRAWAL_REQUEST_TRANSACTION_EXAMPLE })
);

/** A cancellation build answers only a cancellation transaction. */
export const earnExternalWalletWithdrawalRequestCancelTransactionResponse = successResponseSchema(
  z
    .object({ transaction: earnQueuedWithdrawalCancelBuildSchema })
    .openapi({ example: EARN_WITHDRAWAL_REQUEST_CANCEL_TRANSACTION_EXAMPLE })
);

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
      id: z.string().openapi({ example: EARN_EXAMPLE_IDS.strategy }),
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
    shares: earnDecimalAmountSchema,
    minAmountOut: earnDecimalAmountSchema.nullable().openapi({
      description: "The floor encoded in the transaction, or null when the request carried none.",
    }),
  })
  .openapi({ description: "The common fields of one built withdrawal transaction." });

const earnExternalWalletMovementSchema = z
  .object({
    movementId: z.string().openapi({ example: EARN_EXAMPLE_IDS.depositMovement }),
    positionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
    provider: z.string().openapi({ example: "kamino" }),
    providerReference: z.string().openapi({
      example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
    }),
    direction: z.enum(["deposit", "withdrawal"]),
    status: z.enum(["requested", "submitted", "confirmed", "finalized", "failed"]).openapi({
      description:
        "The movement's status. `requested` means SDP recorded the signed " +
        "transaction but has not yet seen it on the network. `confirmed` is " +
        "optimistic and can still be rolled back; only `finalized` and `failed` " +
        "are final.",
    }),
    settlement: z.enum(["atomic", "provider_order"]).openapi({
      description:
        "How the movement settles. `atomic` completes in one transaction, so " +
        "you may show it as done at `confirmed` while SDP tracks finality. " +
        "`provider_order` pays out later through the provider, so chain " +
        "confirmation alone is not payout: the movement stays `confirmed` until the " +
        "provider completes it, and only `finalized` means it is done.",
    }),
    signature: z.string().openapi({ description: "The transaction signature, for explorers." }),
    ownerAddress: earnOwnerAddressFieldSchema,
    amount: earnDecimalAmountSchema.openapi({
      description: "Requested quantity, denominated in `denomination`.",
    }),
    denomination: z.string().openapi({
      description: "Token mint for a deposit; share mint for a withdrawal.",
      example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    }),
    tokenMint: z.string().openapi({
      description:
        "The position's deposit-token mint. Show `tokenAmount` in these units; " +
        "`amount` and `denomination` carry the onchain quantity, which is " +
        "shares on a withdrawal.",
      example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    }),
    tokenAmount: earnDecimalAmountSchema.nullable().openapi({
      description:
        "Quantity in `tokenMint` units. Kamino deposits and all withdrawals require a finalized observation; null beforehand or when the actual debit/payout cannot be observed. Other deposits report their fixed input amount.",
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
    sponsored: z.literal(false).openapi({
      description: "Split swap transactions are never sponsored by SDP.",
    }),
    swap: earnDepositSwapSchema.extend({
      transaction: z.string().openapi({
        description:
          "Base64 wire bytes of the unsigned swap-only transaction. The fee payer " +
          "is the customer, or your request's `feePayer`, which then co-signs it " +
          "too. You broadcast it yourself: it moves only the customer's own " +
          "funds, so SDP records nothing for it.",
      }),
      lastValidBlockHeight: z.string().openapi({ example: "361186610" }),
    }),
    followUp: z
      .object({
        strategyId: z.string().openapi({ example: EARN_EXAMPLE_IDS.strategy }),
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
      "Returned instead of a built transaction when the swap and the deposit " +
      "cannot fit in one Solana transaction (1,232 bytes), even on a compact " +
      "route. SDP saves no build or movement for it.",
  });

export const earnExternalWalletDepositTransactionResponse = successResponseSchema(
  z
    .union([
      z.object({ transaction: earnExternalWalletDepositTransactionSchema }),
      earnExternalWalletDepositSwapSplitSchema,
    ])
    .openapi({ example: EARN_DEPOSIT_TRANSACTION_EXAMPLE })
);

export const earnExternalWalletWithdrawalTransactionResponse = successResponseSchema(
  z
    .object({
      transaction: earnExternalWalletWithdrawalTransactionSchema.extend({
        positionId: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
      }),
    })
    .openapi({ example: EARN_WITHDRAWAL_TRANSACTION_EXAMPLE })
);

export const earnExternalWalletDepositResponse = successResponseSchema(
  z.object({
    deposit: earnExternalWalletMovementSchema.openapi({ example: EARN_DEPOSIT_SUBMIT_EXAMPLE }),
  })
);

export const earnExternalWalletWithdrawalResponse = successResponseSchema(
  z.object({
    withdrawal: earnExternalWalletMovementSchema.openapi({
      example: EARN_WITHDRAWAL_SUBMIT_EXAMPLE,
    }),
  })
);

const earnLiveDecimalAmountSchema = z
  .string()
  .max(128)
  .regex(/^\d+(\.\d+)?$/)
  .openapi({
    description: "Live decimal value returned by the vault provider; never a float.",
    example: "25.42",
  });

export const earnExternalWalletPositionSchema = z
  .object({
    id: z.string().openapi({ example: EARN_EXAMPLE_IDS.position }),
    ownerAddress: earnOwnerAddressFieldSchema,
    provider: z.string().openapi({ example: "kamino" }),
    providerReference: z.string().openapi({
      description: "The strategy's onchain address.",
      example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
    }),
    label: z.string().openapi({ example: "Allez USDC" }),
    tokenMint: z.string().openapi({ example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
    shareMint: z.string().openapi({ example: "hXm2xSRF5PLKGMrTvAWqKhR76MuJX5dAabeSChkjqu2" }),
    createdAt: isoDateTimeSchema,
    closedAt: isoDateTimeSchema.nullable(),
    shares: earnLiveDecimalAmountSchema.optional().openapi({
      description:
        "Live share balance. Absent when the live read is unavailable; never " + "zero-filled.",
    }),
    withdrawableShares: earnLiveDecimalAmountSchema.optional().openapi({
      description:
        "Shares you can withdraw right now. Absent when the live read is " + "unavailable.",
    }),
    unlockTimestamp: z
      .string()
      .regex(/^\d+$/)
      .nullable()
      .optional()
      .openapi({
        description:
          "Unix time, in seconds, when locked shares become withdrawable. Null or " +
          "absent when no lock applies. To tell an unavailable read apart, check " +
          "`shares`.",
        example: "1789722000",
      }),
    tokenValue: earnLiveDecimalAmountSchema.optional().openapi({
      description:
        "Live value of the position in the deposit token (`tokenMint`), as the " +
        "provider reports it: shares times the rate for rate-based strategies, " +
        "or a withdrawal quote for the whole position for quote-based providers " +
        "such as Veda and Ondo. A quote already includes spread and price " +
        "impact, so it does not scale to other share amounts. It is a " +
        "deposit-token amount, not a share count or a USD conversion; every " +
        "Earn deposit token is a USD stablecoin, so at par it reads as dollars. " +
        "Absent when the live read is unavailable.",
    }),
    parIntermediate: z
      .object({
        mint: z.string().openapi({ example: "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih" }),
        amount: earnLiveDecimalAmountSchema,
        withdrawableAmount: earnLiveDecimalAmountSchema.openapi({
          description: "Zero while the provider has frozen the token account.",
        }),
        tokenValue: earnLiveDecimalAmountSchema.openapi({
          description: "Value in the position's deposit token (`tokenMint`).",
        }),
      })
      .optional()
      .openapi({
        description:
          "The operator redemption's intermediate token the wallet holds outside any open " +
          "request, such as Hastra wYLDS after a canceled operator redemption. It belongs to this " +
          "position and is not included in `tokenValue`. Present only while non-zero.",
      }),
  })
  .openapi({ description: "One live position held by a customer wallet." });

const earnExternalWalletTokenTotalSchema = z.object({
  tokenMint: z.string().openapi({ example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  unavailablePositionCount: z.number().int().nonnegative(),
  tokenValue: earnLiveDecimalAmountSchema.optional().openapi({
    description:
      "Exact live total in the deposit token (`tokenMint`): the sum of the positions' `tokenValue` " +
      "plus any `parIntermediate.tokenValue`, a dollar figure at par. Absent when any " +
      "contributing position is unavailable, so partial money is never presented as complete.",
  }),
});

const earnExternalWalletStrategyTotalSchema = z.object({
  provider: z.string().openapi({ example: "kamino" }),
  providerReference: z.string().openapi({
    example: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  }),
  label: z.string().openapi({ example: "Allez USDC" }),
  ownerAddresses: z
    .array(earnOwnerAddressSchema)
    .optional()
    .openapi({
      description:
        "The customer wallets behind this total. Absent unless the request " +
        "passes `includeOwnerAddresses=true`. The list is personal data about " +
        "your customers, so opt in only where you show per-customer detail.",
    }),
  positions: z
    .array(earnExternalWalletPositionSchema)
    .optional()
    .openapi({
      description:
        "Complete live positions contributing to this strategy total. Present only when the " +
        "request passes `includePositions=true` together with `includeOwnerAddresses=true`; use " +
        "this single drill-down instead of one live request per owner.",
    }),
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  totalsByToken: z.array(earnExternalWalletTokenTotalSchema),
});

export const earnExternalWalletPositionsResponse = successResponseSchema(
  z
    .object({
      ownerAddress: earnOwnerAddressFieldSchema,
      positions: z.array(earnExternalWalletPositionSchema),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    })
    .openapi({ example: EARN_POSITIONS_EXAMPLE })
);

export const earnExternalWalletPositionSummaryResponse = successResponseSchema(
  z
    .object({
      summary: z.object({
        walletCount: z.number().int().nonnegative(),
        positionCount: z.number().int().nonnegative(),
        unavailablePositionCount: z.number().int().nonnegative(),
        totalsByStrategy: z.array(earnExternalWalletStrategyTotalSchema),
        totalsByToken: z.array(earnExternalWalletTokenTotalSchema),
      }),
    })
    .openapi({ example: EARN_POSITION_SUMMARY_EXAMPLE })
);

export const earnExternalWalletMovementsResponse = successResponseSchema(
  z
    .object({
      ownerAddress: earnOwnerAddressFieldSchema,
      movements: z.array(earnExternalWalletMovementSchema).openapi({
        description: "The wallet's recorded movements, newest first.",
      }),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    })
    .openapi({ example: EARN_MOVEMENTS_EXAMPLE })
);

export const earnExternalWalletMovementDetailResponse = successResponseSchema(
  z.object({
    movement: earnExternalWalletMovementSchema.openapi({
      example: EARN_MOVEMENT_FINALIZED_EXAMPLE,
    }),
  })
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
      description: "Positions whose live value could not be read.",
    }),
    currentValue: earnLiveDecimalAmountSchema.optional().openapi({
      description:
        "Live value across the token's positions, including any par intermediate they hold. " +
        "Absent when any contributing position is unavailable, so partial money is never " +
        "presented as complete.",
    }),
    totalDeposited: earnLiveDecimalAmountSchema.openapi({
      description:
        "Sum of observed finalized SDP deposits. Excludes unobserved receipts (see `deposits_not_valued`).",
    }),
    totalWithdrawn: earnLiveDecimalAmountSchema.openapi({
      description:
        "Sum of the observed payouts of finalized withdrawals. Always present. " +
        "Excludes withdrawals whose payout SDP did not observe (see " +
        "`withdrawals_not_valued`).",
    }),
    earned: earnSignedDecimalAmountSchema.optional().openapi({
      description:
        "`currentValue + totalWithdrawn - totalDeposited`, present only when " +
        "exact and never zero-filled. The live value reads the wallet's whole " +
        "balance in the strategy, so shares acquired outside SDP raise this " +
        "figure.",
    }),
    earnedUnavailableReason: z
      .enum([
        "live_value_unavailable",
        "movements_pending",
        "withdrawals_pending",
        "deposits_not_valued",
        "withdrawals_not_valued",
      ])
      .optional()
      .openapi({
        description:
          "Why `earned` is absent: `live_value_unavailable` (a live value could " +
          "not be read), `movements_pending` (a movement is still settling), " +
          "`withdrawals_pending` (a held position has an open withdrawal request, " +
          "whose shares leave the wallet before its payout, which can take days), " +
          "or `deposits_not_valued` and `withdrawals_not_valued` (SDP did not " +
          "observe a finalized deposit or withdrawal, so `totalDeposited` or " +
          "`totalWithdrawn` is incomplete).",
      }),
  })
  .openapi({ description: "Earnings for one deposit token across the wallet's positions." });

export const earnExternalWalletEarningsResponse = successResponseSchema(
  z.object({
    earnings: z
      .object({
        ownerAddress: earnOwnerAddressFieldSchema,
        positionCount: z.number().int().nonnegative(),
        unavailablePositionCount: z.number().int().nonnegative(),
        totalsByToken: z.array(earnExternalWalletTokenEarningsSchema),
      })
      .openapi({ example: EARN_EARNINGS_EXAMPLE }),
  })
);

// ---------------------------------------------------------------------------
// Documented list and path parameters. Validation stays in the runtime schemas
// (routes/earn/schemas.ts); these give the reference descriptions and examples.
// ---------------------------------------------------------------------------

export const earnOwnerAddressQueryParam = earnOwnerAddressSchema;

export const earnCursorQueryParams = {
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({
    description: "Page size, from 1 to 100. Defaults to 20.",
  }),
  before: z.string().min(1).optional().openapi({
    description: "The previous page's `nextCursor`. Omit it for the first page.",
  }),
};

export const earnMovementStatusQueryParam = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .openapi({
    description:
      "Return only movements in this status, such as `finalized`. Takes one value; an " +
      "unknown value matches nothing.",
  });

export const earnStrategyIdParam = z.string().min(1).openapi({
  description: "The strategy's `id` from the catalog.",
  example: EARN_EXAMPLE_IDS.mainnetStrategy,
});

export const earnMovementIdParam = z.string().min(1).max(128).openapi({
  description: "The `movementId` a submit returned.",
  example: EARN_EXAMPLE_IDS.depositMovement,
});

export const earnWithdrawalRequestIdParam = z.string().min(1).max(128).openapi({
  description: "The `withdrawalRequestId` a request submit returned.",
  example: EARN_EXAMPLE_IDS.withdrawalRequest,
});
