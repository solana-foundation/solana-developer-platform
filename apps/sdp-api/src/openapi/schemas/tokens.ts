import {
  CAPABILITY_EXTENSIONS,
  TOKEN_MOVEMENT_BASES,
  TOKEN_MOVEMENT_DISPOSITIONS,
  TOKEN_MOVEMENT_PATHS,
  TOKEN_MOVEMENT_REFUSAL_REASONS,
} from "@sdp/types/token-movements";
import { TOKEN_PROGRAM_KINDS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { z } from "zod";
import { isoDateTimeSchema, solanaAddressSchema } from "./base";
import { tokenMovementAmountsSchema } from "./payments";

const TOKEN_UNITS = "token units (base units ÷ 10^decimals)";

export const tokenMintParamsSchema = z
  .object({
    mint: solanaAddressSchema.openapi({
      description: "The token mint address. Native SOL has no mint and no terms.",
      example: WELL_KNOWN_TOKENS.PYUSD.mints["mainnet-beta"].address,
    }),
  })
  .openapi({ description: "Token mint path parameters." });

const transferFeeEntrySchema = z
  .object({
    epoch: z.string().openapi({ description: "First epoch the entry applies in.", example: "0" }),
    basisPoints: z
      .number()
      .int()
      .openapi({ description: "Fee rate in hundredths of a percent.", example: 0 }),
    maximumFee: z.string().openapi({
      description: `Cap on the fee of one transfer, in ${TOKEN_UNITS}.`,
      example: "0",
    }),
  })
  .openapi({ description: "One entry of the mint's transfer-fee schedule." });

const displayTermsSchema = z
  .discriminatedUnion("rule", [
    z.object({ rule: z.literal("plain") }),
    z.object({
      rule: z.literal("scaled"),
      multiplier: z.number().openapi({ description: "Wallets show base units × this." }),
      newMultiplier: z.number().openapi({ description: "The multiplier from its switch time on." }),
      newMultiplierEffectiveAt: isoDateTimeSchema.openapi({
        description: "When `newMultiplier` replaces `multiplier`.",
      }),
    }),
    z.object({
      rule: z.literal("interest"),
      currentRate: z.number().int().openapi({
        description: "Rate in basis points a year from `lastUpdateAt` on; may be negative.",
      }),
      preUpdateAverageRate: z.number().int().openapi({
        description: "Average rate in basis points from `initializedAt` to `lastUpdateAt`.",
      }),
      initializedAt: isoDateTimeSchema,
      lastUpdateAt: isoDateTimeSchema,
    }),
  ])
  .openapi({
    description:
      "How the mint's wallets show an amount: `plain` (token units), `scaled` (Token-2022 scaled UI amount) or `interest` (Token-2022 interest-bearing). Base units never change with it.",
  });

const pathSupportSchema = z
  .object({
    path: z.enum(TOKEN_MOVEMENT_PATHS).openapi({
      description:
        "A movement path: `builder` (Payments transfers, batches, off-ramp funding and payment-request payments) or a module that moves tokens through its own engine.",
      example: "builder",
    }),
    supported: z.boolean().openapi({
      description: "Whether the path can move this token now.",
      example: true,
    }),
    refusals: z
      .array(
        z.object({
          reason: z.enum(TOKEN_MOVEMENT_REFUSAL_REASONS),
          extension: z.enum(CAPABILITY_EXTENSIONS).openapi({
            description: "The Token-2022 mint extension whose state the path refuses.",
          }),
          disposition: z.enum(TOKEN_MOVEMENT_DISPOSITIONS).openapi({
            description:
              "`refuse`: the path will not move it. `hold`: the path waits, for example a recurring pull while the mint is paused.",
          }),
          message: z.string(),
        })
      )
      .openapi({
        description: "Every reason the path cannot move the token; empty when supported.",
      }),
  })
  .openapi({ description: "One movement path's decision for this token." });

export const tokenTermsSchema = z
  .object({
    mint: solanaAddressSchema.openapi({
      example: WELL_KNOWN_TOKENS.PYUSD.mints["mainnet-beta"].address,
    }),
    program: z.enum(TOKEN_PROGRAM_KINDS).openapi({ example: "token-2022" }),
    decimals: z.number().int().nonnegative().openapi({ example: 6 }),
    readAt: z
      .object({
        slot: z.string().openapi({ example: "312000000" }),
        epoch: z.string().openapi({ example: "722" }),
        time: isoDateTimeSchema,
      })
      .openapi({ description: "The Clock read in the same request as the mint." }),
    transferFee: z
      .object({
        current: transferFeeEntrySchema.openapi({
          description: "The fee entry in force in `readAt.epoch`.",
        }),
        next: transferFeeEntrySchema.openapi({
          description:
            "The fee entry in force in the next epoch. A fee change takes effect two epochs after it is set, so it shows here before it applies.",
        }),
      })
      .nullable()
      .openapi({ description: "The transfer-fee schedule; null when the mint has no fee config." }),
    display: displayTermsSchema,
    transferHookProgram: solanaAddressSchema.nullable().openapi({
      description: "The program a transfer hook runs; null when none is set.",
      example: null,
    }),
    paused: z.boolean(),
    nonTransferable: z.boolean(),
    defaultAccountState: z.enum(["initialized", "frozen"]).openapi({
      description: "The state every new token account of the mint starts in.",
    }),
    permanentDelegate: solanaAddressSchema.nullable().openapi({
      description: "An authority that can move any holder's balance; null when none.",
      example: null,
    }),
    confidentialTransfers: z.boolean().openapi({
      description: "Whether the mint allows confidential transfers.",
    }),
    support: z.array(pathSupportSchema).openapi({
      description: "The capability decision of each movement path this deployment runs.",
    }),
  })
  .openapi({ description: "A mint's Token Terms at one read." });

export const quoteTokenAmountRequestSchema = z
  .object({
    amount: z
      .string()
      .optional()
      .openapi({
        description: `The amount to price, in ${TOKEN_UNITS}. Send this or \`displayAmount\`, not both.`,
        example: "100",
      }),
    displayAmount: z.string().optional().openapi({
      description:
        "The amount to price as the mint's wallets show it. SDP converts it to the token amount a request sends: for a `debit`, the largest that shows at most it; for a `credit`, the smallest that shows at least it. Send this or `amount`, not both.",
      example: "150",
    }),
    basis: z.enum(TOKEN_MOVEMENT_BASES).optional().openapi({
      description:
        "Which side of the transfer the amount fixes: `debit` (default) is what leaves the sender, `credit` what the recipient receives.",
      example: "debit",
    }),
  })
  .openapi({
    description:
      "An amount to price under the mint's live terms: exactly one of `amount` (token units) or `displayAmount` (what the mint's wallets show), with an optional `basis`. A body with both, or neither, is a 400.",
    example: { amount: "100", basis: "debit" },
  });

export const tokenAmountQuoteSchema = z
  .object({
    mint: solanaAddressSchema.openapi({
      example: WELL_KNOWN_TOKENS.PYUSD.mints["mainnet-beta"].address,
    }),
    amount: z.string().openapi({
      description: `The token amount the quote prices, in ${TOKEN_UNITS}: \`amount\` as sent, or \`displayAmount\` converted. Send this amount, with the same basis, on the request that moves it.`,
      example: "100",
    }),
    amounts: tokenMovementAmountsSchema,
    feeEpoch: z.string().nullable().openapi({
      description: "The epoch whose fee entry priced `amounts.fee`; null without a fee config.",
      example: null,
    }),
    asOf: isoDateTimeSchema.openapi({ description: "The chain time of the terms read." }),
    expiresAt: isoDateTimeSchema.openapi({
      description:
        "Use the quote before this time. It is never later than a pending multiplier switch, after which the same display amount is another token amount. The movement itself is priced again when it is built.",
    }),
  })
  .openapi({ description: "A movement priced under one read of the mint's terms." });
