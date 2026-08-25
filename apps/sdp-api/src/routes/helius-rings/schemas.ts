import { TRANSFER_MODES, ZONE_KINDS } from "@sdp/helius-rings";
import { z } from "zod";

export const createRingsWalletSchema = z.object({
  /** SDP custody wallet id (`walletId` from GET /v1/wallets). */
  walletId: z.string().min(1),
  name: z.string().min(1).max(120),
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
const SUPPORTED_OP_TYPES = ["shield", "transfer_registered", "withdraw", "merge"] as const;

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

/** `amountRaw` is optional here and required per flow below; a merge has none. */
const assetAmount = z.object({ mint: z.string().min(1), amountRaw: amountRaw.optional() });

/**
 * Native SOL, spelled as SDP spells it.
 *
 * A withdrawal must be SOL: the pool's SPL token-interface address is derived
 * inside the SDK and not exported, so an SPL withdrawal cannot be assembled at
 * all. Refusing it here rather than in the adapter means the caller learns
 * before a policy evaluation and possibly a human approval are spent on it.
 */
// biome-ignore lint/security/noSecrets: the wrapped SOL mint, a public constant.
const SDP_NATIVE_MINT = "So11111111111111111111111111111111111111112";

/**
 * Per-flow shapes, because the fields are not interchangeable.
 *
 * One shared optional-everything object would let a shield through with no
 * asset — and an absent asset must never be read as native SOL by default,
 * because that moves a token the caller never named. It would also accept a
 * `zoneId` on a withdrawal, where nothing would honour it.
 */
export const prepareRingsOperationSchema = z
  .object({
    walletId: z.string().min(1),
    opType: z.enum(SUPPORTED_OP_TYPES, {
      message: `opType must be one of ${SUPPORTED_OP_TYPES.join(", ")}`,
    }),
    asset: assetAmount.optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    zoneId: z.string().min(1).optional(),
    transferMode: z.enum(TRANSFER_MODES).optional(),
    timelock: z
      .object({
        unlockAt: z.iso.datetime(),
        beneficiary: z.string().min(1),
      })
      .optional(),
    /** Caller-supplied; contributes to the intent key so retries are explicit. */
    clientNonce: z.string().min(1).max(128),
  })
  .superRefine((value, ctx) => {
    const require = (field: "asset" | "to", why: string) => {
      if (value[field] === undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: why });
      }
    };
    const refuse = (field: "zoneId" | "timelock" | "transferMode", why: string) => {
      if (value[field] !== undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: why });
      }
    };

    // Zones and timelocks are SDP-side metadata with no builder behind them.
    // Accepting one on a money flow would imply a restriction that is not
    // enforced anywhere.
    refuse("zoneId", "zones are not supported on a money flow");
    refuse("timelock", "timelocks are not supported on a money flow");

    const requireAmount = (why: string) => {
      if (value.asset?.amountRaw === undefined) {
        ctx.addIssue({ code: "custom", path: ["asset", "amountRaw"], message: why });
      }
    };

    if (value.opType === "merge") {
      require("asset", "a merge needs the mint whose notes to consolidate");
      refuse("transferMode", "a merge has no transfer mode");
      // A merge consolidates whatever notes of the mint the wallet holds. An
      // amount here would be recorded on the row and read as real by policy and
      // the activity feed while nothing honours it.
      if (value.asset?.amountRaw !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["asset", "amountRaw"],
          message: "a merge consolidates every note of the mint, so it takes no amount",
        });
      }
      return;
    }

    if (value.opType === "shield") {
      require("asset", "a shield needs the mint and amount to deposit");
      requireAmount("a shield needs the amount to deposit");
      refuse("transferMode", "a shield has no transfer mode");
      return;
    }

    require("asset", `a ${value.opType} needs the mint and amount to move`);
    requireAmount(`a ${value.opType} needs the amount to move`);
    require("to", `a ${value.opType} needs a recipient`);

    if (value.opType === "withdraw") {
      refuse("transferMode", "a withdrawal has no transfer mode");
      if (value.asset && value.asset.mint !== SDP_NATIVE_MINT) {
        ctx.addIssue({
          code: "custom",
          path: ["asset", "mint"],
          message: "only SOL withdrawals are supported",
        });
      }
      return;
    }

    // `registered` is the only mode with a builder, and the database requires
    // exactly that value for this op type — so anything else is a 400 here
    // rather than a constraint violation later. An anonymous transfer is
    // refused before an approval is ever requested for it.
    if (value.transferMode !== undefined && value.transferMode !== "registered") {
      ctx.addIssue({
        code: "custom",
        path: ["transferMode"],
        message: `${value.transferMode} transfers are not supported`,
      });
    }
  })
  // Normalised rather than demanded: the database requires `registered` for
  // this op type, and a caller who named the flow has already said which mode
  // they meant.
  .transform((value) =>
    value.opType === "transfer_registered"
      ? { ...value, transferMode: "registered" as const }
      : value
  );

export const retryRingsOperationSchema = z.object({
  clientNonce: z.string().min(1).max(128),
});

export const createRingsZoneSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(ZONE_KINDS),
});

export const listLimitSchema = z.coerce.number().int().min(1).max(200).optional();
