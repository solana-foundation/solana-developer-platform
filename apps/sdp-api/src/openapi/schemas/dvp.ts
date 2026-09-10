/**
 * Documented shapes for the DvP trade routes.
 *
 * The runtime contract lives in `routes/dvp/schemas.ts`; this file re-wraps it
 * with the documentation metadata. Where a value is a u64 or i64 on chain it is
 * documented as a STRING, because that is what the API accepts and returns — a
 * JSON number rounds above 2^53, and the nonce is a PDA seed, so a rounded value
 * names an escrow address that does not exist.
 */

import { DVP_LEG_OUTCOMES, DVP_TRADE_SIDES, DVP_TRADE_STATUSES } from "@sdp/types";
import {
  createDvpTradeSchema as createDvpTradeSchemaBase,
  dvpTradeIdParamsSchema as dvpTradeIdParamsSchemaBase,
  fundDvpTradeSchema as fundDvpTradeSchemaBase,
  listDvpTradesQuerySchema as listDvpTradesQuerySchemaBase,
} from "../../routes/dvp/schemas";
import { isoDateTimeSchema, withOpenApi, z } from "./base";

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

const dvpLegOutcomeSchema = z.enum(DVP_LEG_OUTCOMES).openapi({
  description:
    "Server-derived leg state: awaiting, partial, funded, overfunded, frozen, reclaimed, expired, delivered, refunded, recoverable after a late deposit, or closed without a recoverable balance.",
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

const dvpTradeLegSchema = z
  .object({
    party: dvpTradePartySchema,
    mint: z.string().openapi({ description: "Mint delivered on this leg." }),
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
        "The transaction that moved this leg into escrow: the funding receipt when one exists, else the live claim's signature while a funding is still in flight (so an in-flight funding links to the transaction it is waiting on), else null. Funding claims are tenant-scoped to the funding organization, so an organization that cannot read the claim row gets null — never a guess.",
    }),
    outcome: dvpLegOutcomeSchema,
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
  })
  .openapi({ description: "One leg of an inbound trade." });

/**
 * A trade another organization created that names one of your addresses.
 *
 * Deliberately NOT `dvpTradeSchema`: the terms are public on chain and are
 * yours to read, but everything around them belongs to the creating
 * organization. The counterparty attribution, funding claims, the derived
 * `kind` and `settlementReadiness` are all withheld, and the serializer builds
 * this shape from scratch rather than trimming the full one so a field added
 * there cannot leak here by default.
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
  createdAccounts: z.array(z.string()).openapi({
    description:
      "Token accounts this transaction had to create because settlement requires them to already exist. They cost rent from the settlement wallet.",
  }),
});
