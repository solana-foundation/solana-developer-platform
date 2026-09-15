/**
 * Documented shapes for the DvP trade routes.
 *
 * The runtime contract lives in `routes/dvp/schemas.ts`; this file re-wraps it
 * with the documentation metadata. Where a value is a u64 or i64 on chain it is
 * documented as a STRING, because that is what the API accepts and returns — a
 * JSON number rounds above 2^53, and the nonce is a PDA seed, so a rounded value
 * names an escrow address that does not exist.
 */

import {
  DVP_LEG_OUTCOMES,
  DVP_LEG_REFUSAL,
  DVP_LEG_TRANSFER_KINDS,
  DVP_SETTLEMENT_AVAILABILITY,
  DVP_TRADE_SIDES,
  DVP_TRADE_STATUSES,
} from "@sdp/types";
import {
  createDvpTradeSchema as createDvpTradeSchemaBase,
  dvpTradeIdParamsSchema as dvpTradeIdParamsSchemaBase,
  fundDvpTradeSchema as fundDvpTradeSchemaBase,
  listDvpTradesQuerySchema as listDvpTradesQuerySchemaBase,
} from "../../routes/dvp/schemas";
import { errorSchema, isoDateTimeSchema, withOpenApi, z } from "./base";

export const dvpTradeIdParamSchema = withOpenApi(dvpTradeIdParamsSchemaBase.shape.tradeId, {
  description: "DvP trade identifier.",
  example: "dvp_4f1c2b8a9d6e4f0b8c7a1d2e3f405162",
});

export const dvpTradeIdParamsSchema = dvpTradeIdParamsSchemaBase;

export const createDvpTradeRequestSchema = withOpenApi(createDvpTradeSchemaBase, {
  description:
    "Terms of the trade to create on chain. Creating a trade commits neither party: only SDP's sponsored fee payer signs, and the trade is a proposal until an escrow is funded.",
});

export const listDvpTradesQuerySchema = listDvpTradesQuerySchemaBase
  .extend({
    status: withOpenApi(listDvpTradesQuerySchemaBase.shape.status, {
      description:
        "Filter by trade status. Accepts a comma-separated list of the documented statuses.",
      example: "created,funded",
    }),
    settlementAvailability: withOpenApi(listDvpTradesQuerySchemaBase.shape.settlementAvailability, {
      description:
        "Filter by settlement availability, as the trade's `settlementAvailability` reports it. Accepts a comma-separated list.",
      example: "available",
    }),
    q: withOpenApi(listDvpTradesQuerySchemaBase.shape.q, {
      description:
        "Case-insensitive substring search over trade ID, the on-chain trade account, both party addresses, both escrow addresses, both mints and both leg symbols. Use at least 2 non-whitespace characters; a blank value is treated as no search filter.",
      example: "USDC",
    }),
  })
  .openapi({ description: "List DvP trades query parameters." });

export const fundDvpTradeRequestSchema = withOpenApi(fundDvpTradeSchemaBase, {
  description:
    "Names the leg to fund and, optionally, which of the caller's custody wallets pays from. The right to fund a side is holding an active custody wallet whose public key is that side's party address — derived at act time, never stored on the trade. An explicit walletId only narrows: it must hold the named side's address.",
});

const dvpTradeStatusSchema = z.enum(DVP_TRADE_STATUSES).openapi({
  description:
    "Last observed lifecycle state. The program emits no events and funding never invokes it, so this is a cache of a poll rather than an event log. `creating` means the create transaction was signed and recorded but its outcome is not yet known. `closed_unknown` means the on-chain account is gone but which terminal path closed it has not been determined.",
  example: "created",
});

const dvpSettlementAvailabilitySchema = z.enum(DVP_SETTLEMENT_AVAILABILITY).nullable().openapi({
  description:
    "Whether the trade can settle, judged by the cluster's Clock read with the last observation (the clock the program checks), never a host clock. `available`: both legs funded and inside the window. `unfunded`: a leg is short. `too_early`: funded, but before `earliestSettlementTimestamp`. `expired`: past expiry, only cancel or reclaim remain. Null for a closed trade, or a funded trade not yet observed with a cluster clock.",
  example: "available",
});

const dvpLegOutcomeSchema = z.enum(DVP_LEG_OUTCOMES).openapi({
  description:
    "Server-derived leg state: awaiting, partial, funded, overfunded, frozen, reclaimed, expired, delivered, refunded, recoverable after a late deposit, or closed without a recoverable balance. An open leg reads from its escrow balance against its amount, and reads reclaimed while the escrow's latest recorded transfer took tokens out and the balance is short of the amount.",
});

const dvpCallerWalletSchema = z
  .object({
    id: z.string().openapi({
      description: "The custody wallet record id holding this address.",
    }),
    name: z.string().nullable().openapi({
      description: "The wallet's display name, or null when none was set.",
    }),
  })
  .nullable()
  .openapi({ description: "The custody wallet, or null." });

export const dvpTradePartySchema = z
  .object({
    address: z.string().openapi({
      description: "Address of the party on this leg.",
      example: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC",
    }),
    counterparty: z
      .object({
        id: z.string().openapi({
          description: "The creator's counterparty account this party resolves to.",
        }),
        label: z.string().openapi({
          description: "The linked counterparty's display name.",
        }),
      })
      .nullable()
      .openapi({
        description:
          "The creator's registered counterparty this party is, or null for an external address. Attribution is org-scoped: only callers in the CREATING organization see it — a viewer from another organization always gets null, even when the trade stores the link. An archived account also reads as null.",
      }),
    wallet: dvpCallerWalletSchema.openapi({
      description:
        "The caller's custody wallet holding this address, or null when the caller custodies nothing for it. Truthy = the caller custodies this party. Derived per caller from the same custody map discovery and funding authorize against; never stored.",
    }),
  })
  .openapi({ description: "One party of the trade, as the caller may see it." });

const dvpLegTransferSchema = z
  .object({
    signature: z.string().openapi({ description: "The transaction that moved the tokens." }),
    direction: z.enum(["in", "out"]).openapi({
      description: "Into the escrow or out of it.",
    }),
    kind: z.enum(DVP_LEG_TRANSFER_KINDS).openapi({
      description:
        "What the movement was: a deposit into the escrow; a reclaim out of it before any close; the settlement's delivery or the cancellation's refund; a recovery of a late deposit after the close; or a withdrawal from a closed trade whose closing transaction is not among the transfers, which cannot be placed against the close.",
    }),
    amount: z.string().openapi({
      description: "Base units moved, always positive, as a decimal string (u64).",
      example: "1000000",
    }),
    slot: z.string().openapi({ description: "Slot the transaction landed in, as a string (u64)." }),
    blockTime: isoDateTimeSchema.nullable().openapi({
      description: "When the block was produced, or null when the cluster recorded no time.",
    }),
    feePayer: z.string().openapi({ description: "The account that paid the transaction's fee." }),
  })
  .openapi({
    description:
      "One token movement in or out of a leg's escrow, read off the chain from the escrow's balance before and after the transaction. Deposits from any address, settlement, cancellation and reclaims all appear here, whoever sent them.",
  });

const dvpLegTransfersSchema = z.array(dvpLegTransferSchema).openapi({
  description:
    "Every recorded token movement in and out of this leg's escrow, oldest first. Filled by a background read of the escrow's history, so a transaction appears shortly after it confirms, not at once. A confirmed transaction the cluster later drops is removed. History before the trade was created is not read.",
});

const dvpTradeLegSchema = z
  .object({
    party: dvpTradePartySchema,
    mint: z.string().openapi({ description: "Mint delivered on this leg." }),
    name: z.string().nullable().openapi({
      description: "The mint's human name, or null when it carries no metadata.",
    }),
    imageUrl: z.string().url().nullable().openapi({
      description:
        "Image of the leg's mint when it is a token this organization issued through SDP; null otherwise.",
    }),
    tokenProgram: z.string().openapi({
      description:
        "Token program owning the mint. A single trade may legitimately mix legacy SPL and Token-2022.",
    }),
    amount: z.string().openapi({
      description: "Exact amount in base units, as a decimal string (u64).",
      example: "1000000",
    }),
    escrow: z.string().openapi({
      description:
        "Address to fund this leg. There is no funding instruction: a party funds by sending an ordinary TransferChecked of exactly `amount` to this address. Send exactly the amount — settlement refunds any surplus to the depositor, and on a transfer-hook mint that refund can revert the whole settlement.",
    }),
    settlementDestination: z.string().openapi({
      description:
        "Address the counter-leg proceeds are delivered to at settlement. Defaults to `party` and may be set to a different address at create, which is ordinary for an execution desk settling into an account other than the one it funded from. Verify it before funding: creating a trade is permissionless and the terms are not bound by the trade's address, so a forged trade naming you can point its proceeds anywhere.",
    }),
    funding: z
      .object({
        observedAmount: z.string().openapi({
          description: "Raw base units last seen in the escrow, as a decimal string (u64).",
        }),
        funded: z.boolean().openapi({
          description:
            "Whether the escrow holds at least the target amount. Settlement requires this on BOTH legs.",
        }),
        surplus: z.string().nullable().openapi({
          description:
            "Amount held above the target, or null. Not harmless: settlement refunds the surplus to its depositor, and on a transfer-hook mint that refund can revert the whole settlement. Anyone can send tokens to an escrow, so a surplus is not rare.",
        }),
        frozen: z.boolean().openapi({
          description:
            "Whether the escrow account is frozen. Funding transfers into a frozen escrow bounce, which a balance of zero cannot distinguish from nobody having paid yet.",
        }),
      })
      .nullable()
      .openapi({
        description:
          "What the reconciler last observed in this escrow, or null before it has looked. Null is not zero.",
      }),
    fundingSignature: z.string().nullable().openapi({
      description:
        "The transfer the calling organization sent into this leg's escrow, once it was broadcast. Null while that transfer is still being sent, for a leg funded by anyone else, and for an organization that did not fund it. Not a record of every deposit: the escrow accepts transfers from any address, and `transfers` lists them all.",
    }),
    outcome: dvpLegOutcomeSchema,
    transfers: dvpLegTransfersSchema,
  })
  .openapi({ description: "One leg of the trade." });

export const dvpTradeSchema = z
  .object({
    id: dvpTradeIdParamSchema,
    status: dvpTradeStatusSchema,
    swapDvp: z.string().openapi({
      description: "On-chain trade account (PDA). The address a counterparty can verify terms at.",
    }),
    settlementAuthority: z.string().openapi({
      description: "The only key that can settle, cancel or reject this trade.",
    }),
    legs: z.object({ a: dvpTradeLegSchema, b: dvpTradeLegSchema }),
    kind: z.enum(["agent", "principal", "bilateral"]).openapi({
      description:
        "The caller's standing on this trade, derived per caller and never stored. Display copy only: how many sides the caller holds an active custody wallet for — 0 is an agent trade (the terms were set for two other parties), 1 is a principal trade, 2 is bilateral. Follows the same custody map discovery and funding authorize against, so a wallet-scoped key's kind reflects its own bindings.",
    }),
    nonce: z.string().openapi({
      description:
        "Per-trade nonce, a decimal string (u64). Part of the PDA seeds, so it is never a JSON number.",
    }),
    expiryTimestamp: z.string().openapi({
      description: "Unix seconds after which the trade can no longer settle, as a string (i64).",
    }),
    earliestSettlementTimestamp: z.string().nullable().openapi({
      description: "Unix seconds before which settlement is refused, as a string (i64), or null.",
    }),
    settlementAvailability: dvpSettlementAvailabilitySchema,
    refString: z.string().nullable().openapi({
      description:
        "Opaque client reference. Unauthenticated — anyone's trade can carry the same value, so treat it as a correlation hint and never as proof of origin.",
    }),
    createSignature: z.string().nullable().openapi({
      description: "Signature of the transaction that created the trade.",
    }),
    observedAt: isoDateTimeSchema.nullable().openapi({
      description: "When the status was last confirmed against the chain.",
    }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .openapi("DvpTrade");

export const dvpTradeResponseSchema = z.object({ trade: dvpTradeSchema });

export const listDvpTradesResponseSchema = z.object({ trades: z.array(dvpTradeSchema) });

/**
 * One leg of an inbound trade, as a party who is not the author may see it.
 *
 * Deliberately NOT `dvpTradeLegSchema`: the author's view derives `funding`
 * and `fundingSignature`, both of which belong to organizations that can read
 * the row and its claims — a party gets the raw observation and null standing.
 */
const dvpInboundLegSchema = z
  .object({
    party: dvpTradePartySchema,
    mint: z.string().openapi({ description: "Mint delivered on this leg." }),
    tokenProgram: z.string().openapi({
      description:
        "Token program owning the mint. A single trade may legitimately mix legacy SPL and Token-2022.",
    }),
    amount: z.string().openapi({
      description: "Exact amount in base units, as a decimal string (u64).",
      example: "1000000",
    }),
    decimals: z.number().nullable().openapi({
      description: "The mint's decimals, or null when the trade predates them being stored.",
    }),
    symbol: z.string().nullable().openapi({
      description: "The mint's symbol, or null when it carries no metadata.",
    }),
    name: z.string().nullable().openapi({
      description: "The mint's human name, or null when it carries no metadata.",
    }),
    imageUrl: z.string().url().nullable().openapi({
      description:
        "Image of the leg's mint when it is a token this organization issued through SDP; null otherwise.",
    }),
    escrow: z.string().openapi({
      description:
        "Address to fund this leg. There is no funding instruction: a party funds by sending an ordinary TransferChecked of exactly `amount` to this address.",
    }),
    settlementDestination: z.string().openapi({
      description:
        "Address the counter-leg proceeds are delivered to at settlement. Verify it before funding.",
    }),
    observedAmount: z.string().nullable().openapi({
      description:
        "Last observed escrow balance, in base units, or null before the reconciler looked.",
    }),
    frozen: z.boolean().nullable().openapi({
      description:
        "Whether the escrow account was last observed frozen. Null before the reconciler looked, which is not the same as thawed.",
    }),
    outcome: dvpLegOutcomeSchema,
    transfers: dvpLegTransfersSchema,
  })
  .openapi({ description: "One leg of an inbound trade." });

/**
 * A trade another organization created that names one of your addresses.
 *
 * Deliberately NOT `dvpTradeSchema`: the terms are public on chain and are
 * yours to read, but everything around them belongs to the creating
 * organization. The counterparty attribution, funding claims, the derived
 * `kind` is withheld, and the serializer builds this shape from scratch rather
 * than trimming the full one so a field added there cannot leak here by default.
 */
export const dvpInboundTradeSchema = z
  .object({
    id: dvpTradeIdParamSchema,
    status: dvpTradeStatusSchema,
    swapDvp: z.string().openapi({
      description: "On-chain trade account (PDA). Verify the terms here before funding.",
    }),
    settlementAuthority: z.string().openapi({
      description: "The only key that can settle, cancel or reject this trade. Not yours.",
    }),
    yourSide: z.enum(DVP_TRADE_SIDES).openapi({
      description: "The leg naming an address you hold the key to, and the only one you may fund.",
    }),
    yourParty: z.string().openapi({
      description: "Your address, as named on that leg.",
    }),
    legs: z.object({ a: dvpInboundLegSchema, b: dvpInboundLegSchema }),
    expiryTimestamp: z.string().openapi({
      description: "Unix seconds after which the trade can no longer settle, as a string (i64).",
    }),
    earliestSettlementTimestamp: z.string().nullable().openapi({
      description: "Unix seconds before which settlement is refused, as a string (i64), or null.",
    }),
    settlementAvailability: dvpSettlementAvailabilitySchema,
    createdAt: isoDateTimeSchema,
    observedAt: isoDateTimeSchema.nullable().openapi({
      description: "When the escrow balances were last confirmed against the chain.",
    }),
  })
  .openapi("DvpInboundTrade");

export const listDvpInboundTradesResponseSchema = z.object({
  trades: z.array(dvpInboundTradeSchema),
});

export const dvpCloseResponseSchema = z.object({
  tradeId: dvpTradeIdParamSchema,
  action: z.enum(["settle", "cancel"]).openapi({
    description:
      "settle delivers each leg to the other party; cancel refunds each leg to whoever deposited it. Both close the trade permanently.",
  }),
  signature: z.string().openapi({ description: "Signature of the closing transaction." }),
});

export const dvpLegActionResponseSchema = z.object({
  tradeId: dvpTradeIdParamSchema,
  leg: z.enum(DVP_TRADE_SIDES).openapi({ description: "The side that was funded or reclaimed." }),
  amount: z.string().openapi({
    description:
      "Base units, as a string (u64). For fund, the shortfall sent. For reclaim, the escrow balance read before sending; the program returns whatever the escrow holds when it executes.",
  }),
  signature: z.string().openapi({ description: "Signature of the transaction." }),
});

/**
 * The error envelope fund and reclaim refuse with. Same shape as every other
 * error, with the refusal code documented, since clients branch on it.
 */
export const dvpLegRefusalErrorResponseSchema = z
  .object({
    error: errorSchema.extend({
      details: z
        .object({
          reason: z.enum(DVP_LEG_REFUSAL).optional().openapi({
            description:
              "Why this leg action was refused, for a client to name in its own words. Absent on refusals that are not about the leg, such as request validation.",
          }),
        })
        .catchall(z.unknown())
        .optional(),
    }),
    meta: z.object({ requestId: z.string().optional() }).optional(),
  })
  .openapi({ description: "Error response for a refused DvP leg action." });
