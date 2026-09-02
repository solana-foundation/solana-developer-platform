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

export const createDvpTradeSchema = z.object({
  /** Custody wallet holding SDP's leg. Signs as party, create payer and fee payer. */
  sdpWalletId: z.string().min(1),
  /** Which leg SDP delivers: "a" is the asset leg, "b" the cash leg. */
  sdpSide: z.enum(["a", "b"]),
  /** The other party. Any address; SDP holds no key for it and it signs nothing. */
  counterparty: solanaAddressSchema,

  mintA: solanaAddressSchema,
  tokenProgramA: solanaAddressSchema,
  mintB: solanaAddressSchema,
  tokenProgramB: solanaAddressSchema,

  amountA: u64StringSchema,
  amountB: u64StringSchema,

  expiryTimestamp: i64StringSchema,
  earliestSettlementTimestamp: i64StringSchema.nullish(),

  /**
   * Opaque client reference, at most 64 bytes. Unauthenticated: anyone's forged
   * create can carry the same value, so it is a correlation hint and never an
   * identity on its own.
   */
  refString: z.string().max(64).nullish(),
});

export const listDvpTradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
