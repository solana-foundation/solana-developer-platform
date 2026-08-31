import { isAddress } from "@sdp/solana/address";
import {
  DEFAULT_EARN_BUTTON_ACCENT_COLOR,
  EARN_APY_TYPES,
  EARN_BUTTON_ACCENT_COLOR_PATTERN,
  EARN_BUTTON_PUBLIC_TOKEN_LENGTH,
  EARN_BUTTON_PUBLIC_TOKEN_PATTERN,
  EARN_BUTTON_STYLES,
  EARN_LIQUIDITY_TERMS,
  EARN_MOVEMENT_DIRECTIONS,
  EARN_PORTFOLIO_TOKENS,
  EARN_STRATEGY_SOURCE_KINDS,
  SOLANA_CLUSTERS,
} from "@sdp/types";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";

export const earnStrategyIdParamsSchema = z.object({
  strategyId: z.string().min(1),
});

/** The page window every earn list shares (see handlers/shared.ts pageWindow). */
const earnPageQueryShape = {
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const listEarnStrategiesQuerySchema = z.object({
  ...earnPageQueryShape,
  sourceKind: z.enum(EARN_STRATEGY_SOURCE_KINDS).optional(),
  apyType: z.enum(EARN_APY_TYPES).optional(),
  liquidityTerm: z.enum(EARN_LIQUIDITY_TERMS).optional(),
  // Explicit cluster opt-in (PRO-1742). Omitted, the list answers the
  // environment's own cluster — the shelf the caller can act on. Naming the
  // foreign cluster browses its mirrored sub-shelf; rows stay fundable: false.
  cluster: z.enum(SOLANA_CLUSTERS).optional(),
});

export const earnButtonConfigurationSchema = z.object({
  strategyId: z.string().min(1).max(128),
  style: z.enum(EARN_BUTTON_STYLES),
  accentColor: z
    .string()
    .regex(EARN_BUTTON_ACCENT_COLOR_PATTERN)
    .default(DEFAULT_EARN_BUTTON_ACCENT_COLOR),
});

export const earnButtonConfigurationPublicParamsSchema = z.object({
  publicToken: z
    .string()
    .length(EARN_BUTTON_PUBLIC_TOKEN_LENGTH)
    .regex(EARN_BUTTON_PUBLIC_TOKEN_PATTERN, "Invalid Earn button integration token"),
});

// ---------------------------------------------------------------------------
// Portfolio programs. An organization holds N per (environment, provider)
// since PRO-1670 — each pinned to one vault, addressed by its own id.
//
// `provider` appears ONLY on the create body and as an optional list filter.
// Every `/programs/:programId` route takes it from the stored row instead: the
// id already identifies the program, and a caller-supplied provider that
// disagreed with the row would have no sensible answer.
// ---------------------------------------------------------------------------

/** Writes stay closed to registered provider ids (ADR 0002 drift rule). */
const earnProviderSchema = z.enum(EARN_PROVIDERS);

/**
 * Strategy weights are authored in percent with 0.1 granularity (the wire
 * contract converts to basis points). Validate the step in tenths — a naive
 * `multipleOf(0.1)` trips on binary-float remainders like 0.3 % 0.1.
 */
const allocationPctSchema = z
  .number()
  .gt(0)
  .max(100)
  .refine((pct) => Math.abs(pct * 10 - Math.round(pct * 10)) < 1e-9, {
    message: "pct must be a multiple of 0.1",
  });

const allocationSchema = z.object({
  yieldSourceId: z.string().min(1),
  pct: allocationPctSchema,
});

const allocationGroupSchema = z
  .array(allocationSchema)
  .min(1)
  // Earn V1 is single-vault (PRO-1667): exactly one entry per token group, so
  // the sum rule below forces it to pct: 100. The weighted multi-entry surface
  // is dormant, not removed — everything downstream still handles N entries,
  // so this bound is all the API side of re-enablement touches. Relaxing it
  // alone does NOT ship weights: the dashboard has no weight authoring or
  // share display (removed by design) and needs that work back first, or the
  // API accepts portfolios the dashboard cannot manage.
  .max(1, { message: "Earn V1 accepts exactly one allocation entry per token group" })
  .superRefine((entries, ctx) => {
    if (new Set(entries.map((entry) => entry.yieldSourceId)).size !== entries.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate yieldSourceId in allocation group" });
    }
    // Sum in integer tenths so 33.3 + 33.3 + 33.4 lands exactly on 100.
    const tenths = entries.reduce((sum, entry) => sum + Math.round(entry.pct * 10), 0);
    if (tenths !== 1000) {
      ctx.addIssue({ code: "custom", message: "Allocation weights must sum to exactly 100" });
    }
  });

// Keys mirror EARN_PORTFOLIO_TOKENS; tokens omitted keep their current allocation.
const earnProgramAllocationsSchema = z
  .object({
    usdc: allocationGroupSchema.optional(),
    usdt: allocationGroupSchema.optional(),
  })
  .refine((groups) => EARN_PORTFOLIO_TOKENS.some((token) => groups[token] !== undefined), {
    message: "allocations must include at least one deposit token group",
  });

export const earnProgramCreateSchema = z.object({
  provider: earnProviderSchema,
  label: z.string().trim().min(1).max(120).optional(),
  allocations: earnProgramAllocationsSchema,
  /**
   * Caller-owned idempotency key (UUIDv4). Optional HERE only because the
   * `Idempotency-Key` header is the other accepted source — the handler requires
   * EXACTLY one and refuses both neither and both, identically to the withdrawal
   * path and for the same reason: no precedence rule can tell which of two
   * sources a caller's retry keeps stable.
   *
   * Creation became key-REQUIRED with PRO-1670. While an organization could hold
   * only one program per (environment, provider), a DB unique constraint caught a
   * retried create; now that N programs are legal, nothing downstream can tell a
   * retry from a genuine second program, and an unkeyed retry provisions a
   * duplicate wallet the customer may then fund.
   */
  requestId: z.uuidv4().optional(),
});

/**
 * Re-target the program's single vault in place. No `provider` (the row owns
 * it) and no `label` (write-once by design — the update path has never
 * forwarded it and there is no repository update path, so accepting one here
 * would silently no-op).
 */
export const earnProgramRetargetSchema = z.object({
  allocations: earnProgramAllocationsSchema,
  /**
   * Optional, unlike create's: re-targeting moves no money and is naturally
   * idempotent on the provider (the same allocations re-applied are a no-op),
   * so an absent key costs a duplicate provider mutation rather than a duplicate
   * wallet. Send one anyway — the provider replays a matching payload and 409s a
   * reused key with changed allocations, which is what makes a double-submitted
   * confirm safe. The `Idempotency-Key` header is the other accepted source,
   * exactly as on create and withdrawals; sending both is a 400.
   */
  requestId: z.uuidv4().optional(),
});

export const earnProgramParamsSchema = z.object({
  programId: z.string().min(1),
});

/** The collection list: `provider` narrows it, absent lists every provider. */
export const earnProgramsListQuerySchema = z.object({
  provider: earnProviderSchema.optional(),
  ...earnPageQueryShape,
});

export const earnProgramDepositsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
});

/** Portfolio flows travel in USD decimal strings, never floats. */
const usdAmountSchema = z
  .string()
  .regex(/^(?!0+(?:\.0+)?$)\d+(?:\.\d{1,6})?$/, "Amount must be a positive USD decimal string");

// Same trim + isAddress convention as payments' solanaAddressSchema: validate
// here for an actionable 400 instead of a provider-side failure downstream.
const solanaDestinationSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().refine((value) => value.length >= 32 && value.length <= 44 && isAddress(value), {
    message: "destinationAddress must be a base58 Solana address",
  })
);

/**
 * The preview and the create used to share a schema by `.extend()`, and they
 * deliberately no longer do.
 *
 * PRO-1675 made the preview's `amountUsd` OPTIONAL — asked without one it
 * answers what the lane can pay right now instead of validating a request. Had
 * the create kept extending the preview, that single edit would have silently
 * made the amount optional on the PAYOUT path too: `POST .../withdrawals` would
 * have accepted a body with no amount. Each schema now DECLARES its own
 * `amountUsd`, so optionality cannot travel between them at all — the
 * relationship a reviewer has to verify is gone rather than merely corrected.
 * Pinned by "keeps amountUsd required even though the preview made it optional"
 * in `../earn-program.test.ts`.
 */
const earnProgramWithdrawalTokenShape = {
  token: z.enum(EARN_PORTFOLIO_TOKENS),
} as const;

export const earnProgramWithdrawalPreviewSchema = z.object({
  /**
   * Omit to ask the liquidity question — "how much can this lane pay right
   * now?" — which is what the withdraw modal asks before the user types
   * anything. Present, it also validates that specific amount is fillable.
   */
  amountUsd: usdAmountSchema.optional(),
  ...earnProgramWithdrawalTokenShape,
});

export const earnProgramWithdrawalCreateSchema = z.object({
  /** REQUIRED — a payout with no amount is not a request. See the note above. */
  amountUsd: usdAmountSchema,
  ...earnProgramWithdrawalTokenShape,
  /**
   * Caller-owned idempotency key (UUIDv4). Optional HERE only because the
   * `Idempotency-Key` header is the other accepted source — the handler
   * requires EXACTLY one and refuses both neither and both, since the provider
   * dedupes a withdrawal on this key alone and no precedence rule can tell
   * which of two sources a caller's retry keeps stable. Either way the value
   * is derived against the program wallet before it reaches the provider, so
   * one organization's key can never collide with another's on the shared
   * account.
   */
  requestId: z.uuidv4().optional(),
  destinationAddress: solanaDestinationSchema,
});

export const earnProgramWithdrawalParamsSchema = earnProgramParamsSchema.extend({
  withdrawalRef: z.string().min(1),
});

/**
 * Withdrawal-ledger list (DB read). Scoped by the path program alone — the
 * provider comes from that row, so there is no query param left to registry-gate
 * and this route keeps taking no provider gate whatsoever (ADR 0002: the audit
 * trail outlives credential removal).
 */
export const earnProgramWithdrawalsListQuerySchema = z.object(earnPageQueryShape);

/**
 * Open a position in a NON-CUSTODIAL vault, or add to one, from an SDP custody
 * wallet.
 *
 * Unlike the custodial create this carries an AMOUNT and a WALLET, because for
 * a `vault_direct` provider opening the position and funding it are the same
 * on-chain action — there is no wallet to provision first and no address to
 * fund afterwards.
 */
export const earnVaultDepositSchema = z.object({
  /** Catalogue strategy id, resolved to a vault address server-side. */
  strategyId: z.string().min(1),
  /** SDP custody-wallet row that signs and holds the shares (`id`, not provider `walletId`). */
  custodyWalletId: z.string().min(1),
  /** Deposit amount in the vault token's units, as a decimal string. */
  amount: z
    .string()
    .max(128)
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .refine((value) => /[1-9]/.test(value), "amount must be greater than zero"),
  /** Optional slippage floor, in shares, as a decimal string. */
  minSharesOut: z
    .string()
    .max(128)
    .regex(/^\d+(\.\d+)?$/, "minSharesOut must be a decimal string")
    .refine((value) => /[1-9]/.test(value), "minSharesOut must be greater than zero")
    .optional(),
  /**
   * Retired on this route: the chain has no request dedupe to anchor a body
   * key to, so the `Idempotency-Key` header is the only accepted source.
   * Declared as `never` rather than omitted so the stray key is rejected with
   * this message instead of being silently stripped.
   */
  requestId: z
    .never(`Use the ${IDEMPOTENCY_KEY_HEADER} header; body requestId is not accepted`)
    .optional(),
});

/**
 * The recorded movement a caller polls. Bounded because the value goes
 * straight into a bind parameter; the row lookup is org-scoped, so anything
 * this organization does not own answers 404 rather than a validation error.
 */
const earnVaultMovementParamsSchema = z.object({
  movementId: z.string().min(1).max(128),
});
export const earnVaultDepositParamsSchema = earnVaultMovementParamsSchema;

/**
 * Bounded keyset page over recorded deposits, newest first.
 *
 * `requestId` narrows to the caller's OWN idempotency key, which is how an
 * approval-gated deposit becomes findable: the approval executor replays the
 * original `Idempotency-Key`, so the movement it eventually creates carries it.
 * A key is caller-chosen and only `[\x20-\x7e]{1,255}` (see
 * `middleware/idempotency-key.ts`), so it can be short and guessable and can
 * contain `/` or `?` — hence a QUERY filter rather than a path segment, and
 * hence the route re-applies every scoping rule the detail route applies
 * instead of treating the key as a capability.
 */
const earnVaultMovementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().min(1).optional(),
  requestId: z.string().min(1).max(255).optional(),
  /**
   * `settled=false` returns only movements that can still change, which is what
   * recovery wants. Without it a client has to page an unbounded history and
   * filter locally — and a workspace busy enough to push an in-flight deposit
   * past the first page would silently stop tracking it.
   */
  settled: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export const earnVaultDepositsQuerySchema = earnVaultMovementsQuerySchema;

/**
 * Exit a non-custodial vault position, redeeming shares back to the custody
 * wallet that holds them.
 *
 * The caller names its own POSITION (from GET /v1/earn/vault-positions), never
 * a catalogue strategy and never a raw vault address — the position row is the
 * source of truth for the instrument and the signing wallet, so an exit works
 * even after the vault is delisted or its provider un-offered (ADR 0002 exit
 * safety). Shares, not token amounts: the share quantity is the only exact
 * intent-time fact a withdrawal has; the position read reports the balance
 * that serves as the ceiling.
 */
export const earnVaultWithdrawalSchema = z.object({
  /** The `earn_positions` row being exited. */
  positionId: z.string().min(1).max(128),
  /** Shares to redeem, decimal string in share units. */
  shares: z
    .string()
    .max(128)
    .regex(/^\d+(\.\d+)?$/, "shares must be a positive decimal string")
    .refine((value) => /[1-9]/.test(value), "shares must be greater than zero"),
  /**
   * Retired on this route for the same reason as the deposit's: the chain has
   * no request dedupe to anchor a body key to, so the `Idempotency-Key` header
   * is the only accepted source.
   */
  requestId: z
    .never(`Use the ${IDEMPOTENCY_KEY_HEADER} header; body requestId is not accepted`)
    .optional(),
});

/** One recorded withdrawal; org-scoped lookup answers 404 for foreign rows. */
export const earnVaultWithdrawalParamsSchema = earnVaultMovementParamsSchema;

/**
 * Bounded keyset page over recorded withdrawals, newest first. The same
 * shape and the same reasoning as the deposits list: `requestId` narrows to
 * the caller's own idempotency key (returning the signed movement, which is
 * how an approval-gated withdrawal becomes findable), and `settled=false` is
 * what recovery asks.
 */
export const earnVaultWithdrawalsQuerySchema = earnVaultMovementsQuerySchema;

// ---------------------------------------------------------------------------
// External-wallet (caller-signed) vault flows (PRO-1722): SDP builds unsigned
// transactions for a wallet it does not custody, and records the movement when
// the signed transaction is submitted back.
// ---------------------------------------------------------------------------

/** Same trim + isAddress convention as the payments destination schema. */
export const solanaOwnerAddressSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().refine((value) => value.length >= 32 && value.length <= 44 && isAddress(value), {
    message: "ownerAddress must be a base58 Solana address",
  })
);

/**
 * Build one unsigned deposit transaction for an external wallet. Shares the
 * custody deposit's amount/floor shapes; the wallet is an ADDRESS, because
 * there is no custody row to name.
 */
export const earnExternalWalletDepositTransactionSchema = z.object({
  /** Catalogue strategy id, resolved to a vault address server-side. */
  strategyId: z.string().min(1),
  /** The external wallet that will sign, own the shares, and pay the fee. */
  ownerAddress: solanaOwnerAddressSchema,
  /** Deposit amount in the vault token's units, as a decimal string. */
  amount: z
    .string()
    .max(128)
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .refine((value) => /[1-9]/.test(value), "amount must be greater than zero"),
  /** Optional slippage floor, in shares, as a decimal string. */
  minSharesOut: z
    .string()
    .max(128)
    .regex(/^\d+(\.\d+)?$/, "minSharesOut must be a decimal string")
    .refine((value) => /[1-9]/.test(value), "minSharesOut must be greater than zero")
    .optional(),
});

/**
 * Build one unsigned exit transaction for an external-wallet position. The
 * caller names its own POSITION, never a strategy and never a raw vault
 * address, for the same ADR 0002 exit-safety reason as the custody exit.
 */
export const earnExternalWalletWithdrawalTransactionSchema = z.object({
  /** The `earn_positions` row being exited. */
  positionId: z.string().min(1).max(128),
  /** Shares to redeem, decimal string in share units. */
  shares: z
    .string()
    .max(128)
    .regex(/^\d+(\.\d+)?$/, "shares must be a positive decimal string")
    .refine((value) => /[1-9]/.test(value), "shares must be greater than zero"),
});

/**
 * Submit the signed bytes back, both directions. `signedTransaction` is
 * bounded by Solana's own packet limit (1,232 bytes is at most 1,644 base64
 * characters); anything larger could never broadcast, so it is refused at the
 * schema. Idempotency is header-only, exactly like the custody vault routes:
 * the chain has no request dedupe to anchor a body key to.
 */
export const earnExternalWalletSubmitSchema = z.object({
  /** The built transaction (`transactionId` from the build response). */
  transactionId: z.string().min(1).max(128),
  /** Base64 wire bytes of the signed transaction. */
  signedTransaction: z
    .string()
    .min(1)
    .max(1700)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "signedTransaction must be base64"),
  /** Retired on this route, same as the custody vault routes. */
  requestId: z
    .never(`Use the ${IDEMPOTENCY_KEY_HEADER} header; body requestId is not accepted`)
    .optional(),
});

export const earnExternalWalletPositionParamsSchema = z
  .object({ ownerAddress: solanaOwnerAddressSchema })
  .strict();

export const earnExternalWalletPositionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before: z.string().min(1).optional(),
  })
  .strict();

export const earnExternalWalletPositionSummaryQuerySchema = z.object({}).strict();

/**
 * The cross-provider movement feed.
 *
 * Filters are narrow on purpose — each one answers a question a dashboard
 * actually asks (what moved, in which direction, through which provider, on which
 * holding, from or to which counterparty address) and every one of them is an
 * equality match the ledger has an index for. `status` is left an open string
 * because the vocabulary is per execution model: a value that belongs to the
 * other model simply matches nothing, which is the honest answer.
 */
export const earnMovementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().min(1).optional(),
  direction: z.enum(EARN_MOVEMENT_DIRECTIONS).optional(),
  status: z.string().min(1).max(64).optional(),
  provider: z.string().min(1).max(64).optional(),
  positionId: z.string().min(1).max(128).optional(),
  sourceAddress: z.string().min(1).max(128).optional(),
  destinationAddress: z.string().min(1).max(128).optional(),
});

/** Bounded keyset page over active vault holdings, newest first. */
export const earnVaultPositionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().min(1).optional(),
});
