import { DVP_TRADE_SIDES } from "@sdp/types";
import { address } from "@solana/kit";
import { z } from "zod";
import { solanaAddressSchema } from "@/routes/payments/schemas";

/**
 * A base58 Solana address, decoded not pattern-matched.
 *
 * Reuses the payments address schema (trim preprocess + 32–44 length window +
 * `isAddress`) and layers `Address` output branding on top via a transform, so
 * values arrive at the service layer already branded. `address()` cannot throw
 * here: the payments schema has already validated with the same check, so the
 * transform only narrows the type.
 */
const dvpAddressSchema = solanaAddressSchema("address").transform((value) => address(value));

/**
 * A u64 as a decimal string.
 *
 * Deliberately not `z.number()`. Amounts and the nonce are u64 on chain, and a
 * JS number silently rounds above 2^53. Accepting a number here would let a
 * caller send an amount we cannot represent, and for the nonce it would derive
 * a different PDA than the one we publish to the counterparty.
 */
const u64StringSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer string")
  .refine((value) => BigInt(value) <= 2n ** 64n - 1n, "must fit in a u64");

/**
 * An i64 seconds timestamp as a decimal string, same reasoning.
 *
 * Range-checked like the u64 above. Only the after-expiry rule reads these, so
 * a wildly out-of-range value passed zod, passed `validateDvpTerms`, and died
 * in the codec as a 500 rather than being refused at the boundary.
 */
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const i64StringSchema = z
  .string()
  .regex(/^-?\d+$/, "must be an integer string")
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed >= I64_MIN && parsed <= I64_MAX;
  }, "must fit in an i64");

export const dvpTradeIdParamsSchema = z.object({
  tradeId: z.string().min(1),
});

/** Terms shared by both kinds of trade. Only the parties differ. */
const dvpTradeTermsShape = {
  /**
   * Custody wallet behind the trade. Signs the create, pays the network fee and
   * pays rent for both escrows. On a principal trade it also delivers a leg; on
   * an agent trade it delivers nothing.
   */
  sdpWalletId: z.string().min(1),

  mintA: dvpAddressSchema,
  tokenProgramA: dvpAddressSchema,
  mintB: dvpAddressSchema,
  tokenProgramB: dvpAddressSchema,

  amountA: u64StringSchema,
  amountB: u64StringSchema,

  expiryTimestamp: i64StringSchema,
  earliestSettlementTimestamp: i64StringSchema.nullish(),

  /**
   * Where each party's proceeds are delivered, when that is not the party.
   *
   * An execution desk routinely settles into an account other than the one it
   * funded from, and the program has always supported it — `CreateDvp` takes
   * both destinations as arguments and records the party's own address when
   * they are omitted. Everything downstream already reads them; only create
   * was dropping them on the floor.
   *
   * Omit for the ordinary trade. A destination that differs from its party is
   * exactly the shape a forged trade takes, so surfaces that show a trade to a
   * counterparty must say when these are set rather than render them quietly.
   */
  userASettlementDestination: dvpAddressSchema.nullish(),
  userBSettlementDestination: dvpAddressSchema.nullish(),

  /**
   * Opaque client reference, at most 64 bytes. Unauthenticated: anyone's forged
   * create can carry the same value, so it is a correlation hint and never an
   * identity on its own.
   */
  refString: z.string().max(64).nullish(),
} as const;

/**
 * The original shape: SDP holds one leg, the counterparty is any address.
 *
 * The V1 shape (PRO-1830), and still the default.
 */
const createPrincipalDvpTradeSchema = z.object({
  ...dvpTradeTermsShape,
  /** Omitted is principal, so existing callers keep working unchanged. */
  tradeKind: z.literal("principal").optional(),
  /** Which leg SDP delivers. The counterparty takes the other. */
  sdpSide: z.enum(DVP_TRADE_SIDES),
  /** The other party. Any address; SDP holds no key for it and it signs nothing. */
  counterparty: dvpAddressSchema,
});

/**
 * The execution-desk shape: SDP sets the terms and two other parties do the
 * swaps.
 *
 * The party that submits a trade is not necessarily a party to it. An execution
 * agent setting up the on-chain swap details and having two counterparties do
 * the swaps is the more common arrangement, and nothing here ruled it out.
 *
 * The program always allowed this: `CreateDvp`'s only signer is the payer, and
 * both parties are plain accounts. There is deliberately no `sdpSide` here —
 * SDP holds neither leg, and a side would name one it has no key for.
 */
const createAgentDvpTradeSchema = z.object({
  ...dvpTradeTermsShape,
  tradeKind: z.literal("agent"),
  /** Delivers leg A. An arbitrary address; signs nothing here. */
  partyA: dvpAddressSchema,
  /** Delivers leg B. Likewise. */
  partyB: dvpAddressSchema,
});

/**
 * Discriminated so the two kinds cannot blur. A body carrying both a side and
 * two parties is refused rather than silently resolved, because guessing which
 * the caller meant is guessing which leg SDP is about to fund.
 */
export const createDvpTradeSchema = z
  .discriminatedUnion("tradeKind", [
    createPrincipalDvpTradeSchema.extend({ tradeKind: z.literal("principal") }),
    createAgentDvpTradeSchema,
  ])
  .or(createPrincipalDvpTradeSchema);

export const listDvpTradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
