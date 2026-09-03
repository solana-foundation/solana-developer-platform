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
  createDvpTradeSchema as createDvpTradeSchemaBase,
  dvpTradeIdParamsSchema as dvpTradeIdParamsSchemaBase,
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
    "Terms of the trade to create on chain. Creating a trade commits neither party: only the fee payer signs, and the trade is a proposal until an escrow is funded.",
});

export const listDvpTradesQuerySchema = listDvpTradesQuerySchemaBase;

const dvpTradeStatusSchema = z
  .enum([
    "creating",
    "create_failed",
    "created",
    "partially_funded",
    "funded",
    "settled",
    "cancelled",
    "rejected",
    "expired",
    "closed_unknown",
  ])
  .openapi({
    description:
      "Last observed lifecycle state. The program emits no events and funding never invokes it, so this is a cache of a poll rather than an event log. `creating` means the create transaction was signed and recorded but its outcome is not yet known. `closed_unknown` means the on-chain account is gone but which terminal path closed it has not been determined.",
    example: "created",
  });

const dvpTradeLegSchema = z
  .object({
    party: z.string().openapi({
      description: "Address of the party on this leg.",
      example: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC",
    }),
    mint: z.string().openapi({ description: "Mint delivered on this leg." }),
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
      description: "Address the counter-leg proceeds are delivered to at settlement.",
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
    sdpSide: z.enum(["a", "b"]).openapi({
      description: "Which leg the SDP custody wallet delivers. The other side is external.",
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
