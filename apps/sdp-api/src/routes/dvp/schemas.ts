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
 * The three variants carry no shared tag key, so this is a `z.union` of three
 * `z.strictObject`s rather than a `z.discriminatedUnion`: strict objects mean
 * exactly one key is present, so the variants cannot blur, with the present key
 * acting as the discriminator the design spec calls for.
 *
 * - `walletId` — a custody wallet of the caller's. Resolves to its address and
 *   stores nothing; fundability is re-derived at act time, and storing it would
 *   be a cache that drifts.
 * - `counterpartyAccountId` — a registered counterparty crypto-wallet account
 *   of the caller's. Resolves the linked address and stores the reference.
 * - `address` — an external address. Stored as nothing but the address.
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
  /**
   * The wallet that signs `CreateDvp`, pays the network fee and both escrows'
   * rent. Optional; omitted means the project's DvP settlement wallet pays.
   * It is not a term of the trade.
   */
  payerWalletId: z.string().min(1).nullish(),
  ...dvpTradeTermsShape,
});

export const listDvpTradesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
