import { z } from "zod";

/** A base58 Solana address. Length range covers 32-byte keys in base58. */
const solanaAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address");

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

/** An i64 seconds timestamp as a decimal string, same reasoning. */
const i64StringSchema = z.string().regex(/^-?\d+$/, "must be an integer string");

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

  mintA: solanaAddressSchema,
  tokenProgramA: solanaAddressSchema,
  mintB: solanaAddressSchema,
  tokenProgramB: solanaAddressSchema,

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
  userASettlementDestination: solanaAddressSchema.nullish(),
  userBSettlementDestination: solanaAddressSchema.nullish(),

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
  sdpSide: z.enum(["a", "b"]),
  /** The other party. Any address; SDP holds no key for it and it signs nothing. */
  counterparty: solanaAddressSchema,
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
  partyA: solanaAddressSchema,
  /** Delivers leg B. Likewise. */
  partyB: solanaAddressSchema,
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
