import {
  DEFAULT_RING_NAME,
  type PrivateOperationInput,
  RING_NAME_PATTERN,
  ZONE_KINDS,
} from "@sdp/helius-rings";
import { SDP_NATIVE_MINT, SDP_USDC_MINT } from "@sdp/helius-rings-sdk";
import { z } from "zod";
import { solanaAddressSchema } from "@/routes/payments/schemas";

export const createRingsWalletSchema = z.object({
  /** SDP custody wallet id (`walletId` from GET /v1/wallets). */
  walletId: z.string().min(1),
  name: z.string().min(1).max(120),
});

export const createProjectRingSchema = z.object({
  /**
   * Operator-chosen handle operations select the ring by. A slug because it
   * appears in request bodies and logs; "default" names the default ring and
   * can never name a ring.
   */
  name: z
    .string()
    .regex(RING_NAME_PATTERN, "name must be a 1-32 character lowercase slug")
    .refine((value) => value !== DEFAULT_RING_NAME, '"default" names the default ring'),
  /** Base58 program id of the pre-deployed custom ring program. */
  ringProgramId: solanaAddressSchema("ringProgramId"),
});

/**
 * The flows this integration implements.
 *
 * Narrower than `OP_TYPES`, which is the vocabulary the database and the state
 * machine can represent. Anything outside this set is refused at the edge rather
 * than accepted and failed later: an operation row that reaches `proving` for a
 * flow nothing can build has already consumed a policy evaluation and possibly
 * a human approval, and it tells the caller far less than a 400 does.
 */
const ENABLED_OP_TYPES = [
  "shield",
  "withdraw",
  "transfer_registered",
  "merge",
  "ring_exit",
  "ring_entry",
] as const;

/**
 * Base units, as a string.
 *
 * A string because these are uint64 amounts and JSON numbers lose precision
 * above 2^53 — a large USDC balance is inside that range. The bound is the
 * protocol's own: an amount no u64 can hold cannot be built, and rejecting it
 * here names the field instead of failing inside a proof.
 */
const amountRaw = z
  .string()
  .regex(/^\d+$/, "amountRaw must be a base-unit integer string")
  .refine((value) => BigInt(value) > 0n, "amountRaw must be greater than zero")
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n, "amountRaw exceeds u64");

/**
 * The assets a spend may name.
 *
 * Narrower than the `helius_rings_assets` catalogue, and narrower on purpose:
 * these are the two whose settlement path the SDK's builders assemble and the
 * outer-transaction policy re-derives. Refusing anything else here rather than
 * in the adapter means the caller learns before a policy evaluation and
 * possibly a human approval are spent on it.
 *
 * The same two on a custom ring: the ring builders take the asset too, and the
 * wire policy re-derives the SPL settlement on that rail as well.
 */
const spendMint = z.union([z.literal(SDP_NATIVE_MINT), z.literal(SDP_USDC_MINT)], {
  error: "only SOL and USDC spends are supported",
});

/**
 * Per-flow shapes, because accepting a field no builder honours would record a
 * restriction or amount that policy and the activity feed read as real.
 *
 * The nested assets are strict too, so a misspelled or flow-incompatible field
 * is refused rather than silently stripped.
 */
const operationFields = {
  walletId: z.string().min(1),
  /** Caller-supplied; contributes to the intent key so retries are explicit. */
  clientNonce: z.string().min(1).max(128),
} as const;

const mint = z.string().min(1);
const assetAmount = z.strictObject({ mint, amountRaw });

/**
 * Ring NAME the operation targets; the server resolves and pins the program id
 * at prepare time. Omitted or "default" = the default ring. For ring-bound
 * spends and ring_exit the named ring is the SOURCE of funds; for ring shields
 * and ring_entry it is the destination. Existence and bring-up state are the
 * service's checks, not the schema's.
 */
const ring = z
  .union([z.literal(DEFAULT_RING_NAME), z.string().regex(RING_NAME_PATTERN)])
  .optional();

/**
 * A ring move's ring: required, and never "default" — the move's other side is
 * always the default pool, so naming the default on both sides is a no-op the
 * caller almost certainly didn't mean.
 */
const customRing = z
  .string()
  .regex(RING_NAME_PATTERN)
  .refine((value) => value !== DEFAULT_RING_NAME, {
    error: "a ring move names a custom ring; the default pool is the other side",
  });

/** ring_exit and ring_entry share one shape; only the opType literal differs. */
const ringMoveSchema = (opType: "ring_exit" | "ring_entry") =>
  z.strictObject({
    ...operationFields,
    opType: z.literal(opType),
    asset: z.strictObject({
      mint: z.literal(SDP_NATIVE_MINT, {
        error: "only SOL ring moves are supported",
      }),
      amountRaw,
    }),
    ring: customRing,
  });

export const prepareRingsOperationSchema = z
  .discriminatedUnion(
    "opType",
    [
      z.strictObject({
        ...operationFields,
        opType: z.literal("shield"),
        asset: assetAmount,
        ring,
      }),
      z.strictObject({
        ...operationFields,
        opType: z.literal("withdraw"),
        asset: z.strictObject({
          mint: spendMint,
          amountRaw,
        }),
        to: z.string().min(1),
        ring,
      }),
      z.strictObject({
        ...operationFields,
        opType: z.literal("transfer_registered"),
        asset: z.strictObject({
          mint: spendMint,
          amountRaw,
        }),
        /** Recipient's canonical shielded address; the service resolves it to a same-tenant wallet. */
        to: z.string().min(1),
        ring,
      }),
      z.strictObject({
        ...operationFields,
        opType: z.literal("merge"),
        /**
         * No amount and no recipient: a merge consolidates the wallet's own
         * notes for one asset, and the value it writes back is whatever those
         * notes already held. Naming an amount would imply a choice the caller
         * does not get.
         */
        asset: z.strictObject({ mint: spendMint }),
        // No `ring`: ring-bound notes are consolidated by an instruction the
        // protocol reserves a tag for but ships no builder for, so a merge is
        // always the default ring's.
      }),
      // The two ring moves: the wallet's own funds cross between the named
      // custom ring and the default pool. No `to` — both directions are
      // self-only by construction in the SDK.
      ringMoveSchema("ring_exit"),
      ringMoveSchema("ring_entry"),
    ],
    {
      error: `opType must be one of ${ENABLED_OP_TYPES.join(", ")}`,
    }
  )
  .transform((value) => value satisfies PrivateOperationInput);

export const retryRingsOperationSchema = z.object({
  clientNonce: z.string().min(1).max(128),
});

export const voidRingsOperationSchema = z.object({
  signature: z.string().min(1),
});

/**
 * The wallet's own name, typed back. Re-keying cannot be undone, so the request
 * has to name what it is about to discard; the service compares it.
 */
export const rekeyRingsWalletSchema = z.object({
  confirmation: z.string().min(1).max(120),
});

export const createRingsZoneSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(ZONE_KINDS),
});

export const listLimitSchema = z.coerce.number().int().min(1).max(200).optional();
