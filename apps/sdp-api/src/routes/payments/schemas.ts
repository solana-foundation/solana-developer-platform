import { isIsoDuration } from "@sdp/policy";
import { assertIsAddress, isAddress } from "@sdp/solana/address";
import { isDecimalString } from "@sdp/solana/amount";
import {
  COUNTRY_CODES,
  type CoinbaseRampEvent,
  isWellKnownTokenSymbol,
  type MoneygramRampEvent,
  MURAL_SANDBOX_PAYIN_CURRENCIES,
  OFFRAMP_CRYPTO_RAILS,
  ONRAMP_CRYPTO_RAILS,
  type PolicyRule,
  RAMP_PROVIDERS,
  RAMPS_MEMO_LIMITS,
  WALLET_OPERATION_FAMILIES,
  WALLET_OPERATION_TYPES,
} from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp";
import {
  getI64Encoder,
  getU64Encoder,
  isSolanaError,
  SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH,
  SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE,
  SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE,
} from "@solana/kit";
import { z } from "zod";
import { SOL_MINT } from "@/services/payment-operation.service";

export function solanaAddressSchema(fieldName: string) {
  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      try {
        assertIsAddress(value);
      } catch (error) {
        if (isSolanaError(error, SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE)) {
          ctx.addIssue({
            code: "custom",
            message: `${fieldName} must be 32 to 44 characters (got ${error.context.actualLength})`,
            input: value,
          });
          return;
        }
        if (isSolanaError(error, SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE)) {
          ctx.addIssue({
            code: "custom",
            message: `${fieldName} contains characters outside the base58 alphabet`,
            input: value,
          });
          return;
        }
        if (isSolanaError(error, SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH)) {
          ctx.addIssue({
            code: "custom",
            message: `${fieldName} must decode to 32 bytes (got ${error.context.actualLength})`,
            input: value,
          });
          return;
        }
        throw error;
      }
    });
}

// Payments token field: a well-known token symbol (SOL, USDC, ...) or a base58
// Solana mint address. Trim and case-fold symbols in a preprocess so validation
// matches `normalizePaymentToken` (which resolves well-known symbols to the
// configured cluster's mint). A single refine (rather than a union with
// `.min(32)`) avoids generic "String must contain at least 32 character(s)"
// errors for short inputs like `"BTC"`.
export const PAYMENT_TOKEN_VALIDATION_MESSAGE =
  "token must be a well-known token symbol (e.g. 'SOL', 'USDC') or a base58 Solana mint address";

export const paymentTokenSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    const symbol = trimmed.toUpperCase();
    return isWellKnownTokenSymbol(symbol) ? symbol : trimmed;
  },
  z.string().refine(
    (value) => {
      if (isWellKnownTokenSymbol(value) || value === SOL_MINT) return true;
      return value.length >= 32 && value.length <= 44 && isAddress(value);
    },
    { message: PAYMENT_TOKEN_VALIDATION_MESSAGE }
  )
);

export const walletIdParamsSchema = z.object({
  walletId: z.string().min(1),
});

export const walletPolicyEvaluationParamsSchema = walletIdParamsSchema.extend({
  policyEvaluationId: z.string().min(1),
});

export const walletPolicyEvaluationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  decision: z
    .enum([
      "allow",
      "deny",
      "approval_required",
      "provider_approval_required",
      "review",
      "not_evaluated",
    ])
    .optional(),
  status: z
    .enum([
      "created",
      "evaluated",
      "pending_approval",
      "executing",
      "completed",
      "failed",
      "canceled",
    ])
    .optional(),
  operationFamily: z.enum(WALLET_OPERATION_FAMILIES).optional(),
  reasonCode: z.string().min(1).max(100).optional(),
});

export const transferIdParamsSchema = z.object({
  transferId: z.string().min(1),
});

const policyRuleBaseShape = {
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  action: z
    .enum(["allow", "deny", "approval_required", "provider_approval_required", "review"])
    .optional(),
};

const walletOperationFamilySchema = z.enum(WALLET_OPERATION_FAMILIES);
const walletOperationTypeSchema = z.enum(WALLET_OPERATION_TYPES, {
  error: "operation type must be one of the supported wallet operation types",
});

export const walletPolicyRuleSchema: z.ZodType<PolicyRule> = z.discriminatedUnion("kind", [
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("operation_family"),
    family: walletOperationFamilySchema.optional(),
    families: z.array(walletOperationFamilySchema).max(20).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("operation_type"),
    operationType: walletOperationTypeSchema.optional(),
    operationTypes: z.array(walletOperationTypeSchema).max(100).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("asset"),
    asset: z.string().min(1, "asset must not be empty").max(120).optional(),
    assets: z
      .array(z.string().min(1, "assets entries must not be empty").max(120))
      .max(100)
      .optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("destination"),
    allowlist: z.array(solanaAddressSchema("allowlist entry")).max(500).optional(),
    blocklist: z.array(solanaAddressSchema("blocklist entry")).max(500).optional(),
    destination: solanaAddressSchema("destination").optional(),
    destinations: z.array(solanaAddressSchema("destinations entry")).max(500).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("amount"),
    min: z
      .string()
      .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
      .optional(),
    max: z
      .string()
      .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
      .optional(),
    asset: z.string().min(1).max(120).optional(),
    assets: z.array(z.string().min(1).max(120)).max(100).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("velocity"),
    scope: z.enum(["wallet", "organization", "api_key"]).optional(),
    window: z.string().refine((value) => isIsoDuration(value), {
      message: "window must be an ISO 8601 duration such as PT1H, P1D or P1DT12H",
    }),
    max: z.string().refine((value) => isDecimalString(value), { message: "Invalid amount format" }),
    asset: z.string().min(1).max(120).optional(),
    assets: z.array(z.string().min(1).max(120)).max(100).optional(),
    operationTypes: z.array(walletOperationTypeSchema).max(100).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("approval"),
    families: z.array(walletOperationFamilySchema).max(20).optional(),
    operationTypes: z.array(walletOperationTypeSchema).max(100).optional(),
    assets: z.array(z.string().min(1).max(120)).max(100).optional(),
    approvalGroupId: z.string().min(1).max(120).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("always"),
  }),
]);

export const updateWalletPolicyBaseSchema = z.object({
  commitMessage: z.string().trim().min(1).max(500).optional(),
  defaultAction: z.enum(["allow", "deny", "approval_required", "review"]),
  rules: z.array(walletPolicyRuleSchema).max(100),
  // Stale-write guard. Every update activates a revision, so the active
  // revision id versions the whole policy; null means "expect no profile yet".
  expectedRevisionId: z.string().min(1).max(120).nullable().optional(),
});

/**
 * Cross-rule constraints shared by every policy-rules payload: unique rule
 * ids, and amount and velocity rules keyed by asset mint (a bound is
 * meaningless across tokens, so an asset-less rule is rejected rather than
 * blanket-applied).
 *
 * @param rules - The parsed rules array.
 * @param ctx - The zod refinement context to report issues on.
 */
export function refinePolicyRules(rules: PolicyRule[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (
      rule.kind === "amount" &&
      rule.asset === undefined &&
      (rule.assets === undefined || rule.assets.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["rules", index],
        message: "Amount rules must name the asset mint(s) they bound",
      });
    }
    if (
      rule.kind === "velocity" &&
      rule.asset === undefined &&
      (rule.assets === undefined || rule.assets.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["rules", index],
        message: "Velocity rules must name the asset mint(s) they bound",
      });
    }
    if (rule.id === undefined) {
      continue;
    }
    if (seen.has(rule.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: `Duplicate rule id: ${rule.id}`,
      });
    }
    seen.add(rule.id);
  }
}

export const updateWalletPolicySchema = updateWalletPolicyBaseSchema.superRefine((policy, ctx) =>
  refinePolicyRules(policy.rules, ctx)
);

export const paymentAmountSchema = z
  .string()
  .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
  // Avoid adding a second error when the decimal-format check already failed.
  .refine((value) => !isDecimalString(value) || /[1-9]/.test(value), {
    message: "Amount must be greater than zero",
  });

export const recurringTimestampSchema = z.string().datetime({ offset: true });
export const u64StringSchema = z
  .string()
  .regex(/^\d+$/, { message: "Value must be an unsigned integer string" })
  .refine((value) => {
    try {
      getU64Encoder().encode(BigInt(value));
      return true;
    } catch {
      return false;
    }
  }, "Value must fit in an unsigned 64-bit integer");
export const i64StringSchema = z
  .string()
  .regex(/^-?\d+$/, { message: "Value must be a signed integer string" })
  .refine((value) => {
    try {
      getI64Encoder().encode(BigInt(value));
      return true;
    } catch {
      return false;
    }
  }, "Value must fit in a signed 64-bit integer");

export const rampProviderSchema = z.enum(RAMP_PROVIDERS);
export const rampDirectionSchema = z.enum(["onramp", "offramp"]);
export const onrampCryptoRailSchema = z.enum(ONRAMP_CRYPTO_RAILS);
export const offrampCryptoRailSchema = z.enum(OFFRAMP_CRYPTO_RAILS);
export const rampFiatCurrencySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(RAMP_FIAT_CURRENCIES)
);

export const cancelRampTransferSchema = z.object({
  transferId: z.string().min(1),
});

export const listOnrampCurrenciesQuerySchema = z.object({
  source: rampFiatCurrencySchema.optional(),
  dest: onrampCryptoRailSchema.optional(),
  provider: rampProviderSchema.optional(),
});

export const listOfframpCurrenciesQuerySchema = z.object({
  source: offrampCryptoRailSchema.optional(),
  dest: rampFiatCurrencySchema.optional(),
  provider: rampProviderSchema.optional(),
});

export const estimateOnrampSchema = z.strictObject({
  assetRail: onrampCryptoRailSchema,
  fiatCurrency: rampFiatCurrencySchema,
  fiatAmount: paymentAmountSchema,
});

export const estimateOfframpSchema = z.strictObject({
  assetRail: offrampCryptoRailSchema,
  fiatCurrency: rampFiatCurrencySchema,
  cryptoAmount: paymentAmountSchema,
});

export const rampsMemoSchema = z
  .record(
    z.string().min(1).max(RAMPS_MEMO_LIMITS.maxKeyLength),
    z.string().min(1).max(RAMPS_MEMO_LIMITS.maxValueLength)
  )
  .refine((value) => Object.keys(value).length <= RAMPS_MEMO_LIMITS.maxEntries, {
    message: `rampsMemo must contain at most ${RAMPS_MEMO_LIMITS.maxEntries} key-value pairs`,
  });

export const createOnrampQuoteSchema = z.strictObject({
  provider: rampProviderSchema,
  counterpartyId: z.string().min(1),
  destinationCustodyWalletId: z.string().min(1),
  assetRail: onrampCryptoRailSchema,
  fiatCurrency: rampFiatCurrencySchema,
  fiatAmount: paymentAmountSchema,
  rampsMemo: rampsMemoSchema.optional(),
  // Embedding domain for Coinbase's Apple Pay payment link (browser origin host).
  domain: z.string().min(1).optional(),
});

const collectedDataSchema = z.record(z.string(), z.string()).optional();

export const rampDestinationCountrySchema = z.enum(COUNTRY_CODES);

export const submitCounterpartyRequirementsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("moonpay"), direction: rampDirectionSchema }),
  z.object({ provider: z.literal("moneygram"), direction: rampDirectionSchema }),
  z.discriminatedUnion("direction", [
    z.object({
      provider: z.literal("bvnk"),
      direction: z.literal("onramp"),
      assetRail: onrampCryptoRailSchema,
      destinationCustodyWalletId: z.string().min(1),
      fiatCurrency: rampFiatCurrencySchema,
      collectedData: collectedDataSchema,
      agreementConsent: z.literal(true).optional(),
    }),
    z.object({
      provider: z.literal("bvnk"),
      direction: z.literal("offramp"),
      assetRail: offrampCryptoRailSchema,
      fiatCurrency: rampFiatCurrencySchema,
      collectedData: collectedDataSchema,
      agreementConsent: z.literal(true).optional(),
    }),
  ]),
  z.discriminatedUnion("direction", [
    z.object({
      provider: z.literal("lightspark"),
      direction: z.literal("onramp"),
      collectedData: collectedDataSchema,
    }),
    z.object({
      provider: z.literal("lightspark"),
      direction: z.literal("offramp"),
      assetRail: offrampCryptoRailSchema,
      fiatCurrency: rampFiatCurrencySchema,
      collectedData: collectedDataSchema,
      providerAccountId: z.string().min(1).optional(),
    }),
  ]),
  z.object({ provider: z.literal("coinbase"), direction: rampDirectionSchema }),
  z.discriminatedUnion("direction", [
    z.object({
      provider: z.literal("mural"),
      direction: z.literal("onramp"),
      assetRail: onrampCryptoRailSchema,
      destinationCustodyWalletId: z.string().min(1),
      fiatCurrency: rampFiatCurrencySchema,
    }),
    z.object({
      provider: z.literal("mural"),
      direction: z.literal("offramp"),
      assetRail: offrampCryptoRailSchema,
      fiatCurrency: rampFiatCurrencySchema,
    }),
  ]),
  z.object({ provider: z.literal("stripe"), direction: rampDirectionSchema }),
]);

const offrampQuoteBaseShape = {
  counterpartyId: z.string().min(1),
  sourceCustodyWalletId: z.string().min(1),
  assetRail: offrampCryptoRailSchema,
  cryptoAmount: paymentAmountSchema,
  rampsMemo: rampsMemoSchema.optional(),
};

export const createOfframpQuoteSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("lightspark"),
    ...offrampQuoteBaseShape,
    fiatCurrency: rampFiatCurrencySchema,
    destinationCountry: rampDestinationCountrySchema,
    providerAccountId: z.string().min(1).optional(),
  }),
  z.strictObject({
    provider: z.enum(["moonpay", "bvnk", "moneygram", "mural", "coinbase", "stripe"]),
    ...offrampQuoteBaseShape,
    fiatCurrency: rampFiatCurrencySchema.optional(),
  }),
]);

export const moneygramRampEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("transaction_created"),
    sessionId: z.string().min(1),
    transactionId: z.string().min(1),
    mgiTransactionId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("deposit_address"),
    sessionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("onramp_completed"),
    sessionId: z.string().min(1),
    transactionId: z.string().min(1),
    status: z.string().min(1),
    amount: z.number().positive(),
    referenceNumber: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("signed"),
    sessionId: z.string().min(1),
    cryptoTransferId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("completed"),
    sessionId: z.string().min(1),
    cryptoTransferId: z.string().min(1),
    transactionId: z.string().min(1),
    payoutAmount: z.number().positive(),
    payoutStatus: z.string().min(1),
    referenceNumber: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("errored"),
    sessionId: z.string().min(1),
    reason: z.string().min(1),
    cryptoTransferId: z.string().min(1).optional(),
    transactionId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("closed"),
    sessionId: z.string().min(1),
  }),
]) satisfies z.ZodType<MoneygramRampEvent>;

export const coinbaseRampEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("committed"), orderId: z.string().min(1) }),
  z.object({ kind: z.literal("errored"), orderId: z.string().min(1), reason: z.string().min(1) }),
]) satisfies z.ZodType<CoinbaseRampEvent>;

const simulateLightsparkSandboxTransferPayloadSchema = z.object({
  quoteId: z.string().min(1),
  currencyCode: z.enum(["USD", "USDC"]).default("USD"),
  currencyAmount: z.number().int().positive().optional(),
});

const simulateBvnkSandboxPayinPayloadSchema = z.object({
  transferId: z.string().min(1),
});

const simulateMuralSandboxPayinPayloadSchema = z.object({
  counterpartyId: z.string().min(1),
  amount: z.number().positive(),
  fiatCurrency: z.enum(MURAL_SANDBOX_PAYIN_CURRENCIES),
});

export const simulateSandboxTransferSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("lightspark"),
    payload: simulateLightsparkSandboxTransferPayloadSchema,
  }),
  z.object({
    provider: z.literal("bvnk"),
    payload: simulateBvnkSandboxPayinPayloadSchema,
  }),
  z.object({
    provider: z.literal("mural"),
    payload: simulateMuralSandboxPayinPayloadSchema,
  }),
]);
