import { z } from "zod";
import { errorResponseSchema, isoDateTimeSchema, successResponseSchema } from "./base";
import {
  EARN_EXAMPLE_IDS,
  EARN_OWNER_ADDRESS_EXAMPLE,
  EARN_STRATEGY_EXAMPLE,
} from "./earn-examples";

/** A provider capability unavailable through the core contract. */
export const earnNotImplementedErrorResponseSchema = errorResponseSchema.extend({
  error: errorResponseSchema.shape.error.extend({ code: z.literal("NOT_IMPLEMENTED") }),
});

const earnOwnerAddressFieldSchema = z.string().openapi({
  description: "The wallet owner's Solana address.",
  example: EARN_OWNER_ADDRESS_EXAMPLE,
});
const earnOwnerAddressSchema = earnOwnerAddressFieldSchema;

const earnStrategySlippagePolicySchema = z
  .object({
    quoteRequired: z.literal(true).openapi({
      description: "Preparation reads a live quote before building this direction.",
    }),
    defaultToleranceBps: z.number().int().openapi({
      description:
        "Suggested tolerance in basis points. Core preparation derives the protection floor.",
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
      description: "The strategy's ID. Pass it as `strategyId` to prepare a deposit.",
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
        "Quote protection supported for deposits. Preparation derives the minimum shares from the live quote and chosen tolerance.",
    }),
    withdrawalSlippage: earnStrategySlippagePolicySchema.nullable().openapi({
      description:
        "Quote protection supported for withdrawals. Preparation derives the minimum output from the live quote and chosen tolerance.",
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
        "Whether the configured paymaster can sponsor a wallet movement on this strategy. Preparation resolves the selected source's actual fee policy.",
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

const earnLiveDecimalAmountSchema = z
  .string()
  .max(128)
  .regex(/^\d+(\.\d+)?$/)
  .openapi({
    description: "Live decimal value returned by the vault provider; never a float.",
    example: "25.42",
  });

export const earnWalletPositionSchema = z
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
        "deposit-token amount, not a share count or a USD conversion; no USD conversion is implied. Absent when the live read is unavailable.",
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

const earnWalletTokenTotalSchema = z.object({
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

const earnWalletStrategyTotalSchema = z.object({
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
    .array(earnWalletPositionSchema)
    .optional()
    .openapi({
      description:
        "Complete live positions contributing to this strategy total. Present only when the " +
        "request passes `includePositions=true` together with `includeOwnerAddresses=true`; use " +
        "this single drill-down instead of one live request per owner.",
    }),
  walletCount: z.number().int().nonnegative(),
  positionCount: z.number().int().nonnegative(),
  totalsByToken: z.array(earnWalletTokenTotalSchema),
});

export const earnWalletPositionSummaryResponse = successResponseSchema(
  z.object({
    summary: z.object({
      walletCount: z.number().int().nonnegative(),
      positionCount: z.number().int().nonnegative(),
      unavailablePositionCount: z.number().int().nonnegative(),
      totalsByStrategy: z.array(earnWalletStrategyTotalSchema),
      totalsByToken: z.array(earnWalletTokenTotalSchema),
    }),
  })
);
