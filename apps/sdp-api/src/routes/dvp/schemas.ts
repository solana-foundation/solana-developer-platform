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

/**
 * One party slot, used for both `partyA` and `partyB`.
 *
 * `z.union` of three strict objects (no shared tag key; exactly one key
 * present acts as the discriminator): `walletId` (resolves to its address,
 * stores nothing), `counterpartyAccountId` (resolves the linked address,
 * stores the ref), or a bare external `address`.
 */
const dvpPartySchema = z.union([
  z.strictObject({ walletId: z.string().min(1) }),
  z.strictObject({ counterpartyAccountId: z.string().min(1) }),
  z.strictObject({ address: dvpAddressSchema }),
]);

/** Terms shared by every trade. Only the parties differ. */
const dvpTradeTermsShape = {
  mintA: dvpAddressSchema,
  tokenProgramA: dvpAddressSchema,
  mintB: dvpAddressSchema,
  tokenProgramB: dvpAddressSchema,

  amountA: u64StringSchema,
  amountB: u64StringSchema,

  expiryTimestamp: i64StringSchema,
  earliestSettlementTimestamp: i64StringSchema.nullish(),

  /**
   * Where each party's proceeds are delivered instead of to the party. Omit
   * for the ordinary trade; a differing destination is also the shape a forged
   * trade takes, so surfaces showing a trade to a counterparty must surface it.
   */
  userASettlementDestination: dvpAddressSchema.nullish(),
  userBSettlementDestination: dvpAddressSchema.nullish(),

  /** Opaque client reference, at most 64 bytes; a correlation hint, never an identity. */
  refString: z.string().max(64).nullish(),
} as const;

/**
 * The create body: two symmetric party slots and the trade terms.
 *
 * `partyA` and `partyB` are {@link dvpPartySchema} slots; `payerWalletId` is the
 * fee/rent signer and is NOT a term of the trade. Omitted, the project's DvP
 * settlement wallet pays — and, closing every trade, later receives the rent
 * back.
 */
export const createDvpTradeSchema = z.object({
  partyA: dvpPartySchema,
  partyB: dvpPartySchema,
  /** Fee/rent signer; omitted means the settlement wallet pays. Not a term of the trade. */
  payerWalletId: z.string().min(1).nullish(),
  ...dvpTradeTermsShape,
});

export const listDvpTradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * The fund body: which leg, and optionally which of the caller's wallets pays
 * (it must hold that side's party address — naming one narrows, never widens).
 */
export const fundDvpTradeSchema = z.object({
  side: z.enum(DVP_TRADE_SIDES),
  walletId: z.string().min(1).nullish(),
});
