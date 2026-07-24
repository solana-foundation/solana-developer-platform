import { isAddress } from "@sdp/solana/address";
import { isDecimalString } from "@sdp/solana/amount";
import {
  type CoinbaseRampEvent,
  isWellKnownTokenSymbol,
  type MoneygramRampEvent,
  MURAL_SANDBOX_PAYIN_CURRENCIES,
  OFFRAMP_CRYPTO_RAILS,
  ONRAMP_CRYPTO_RAILS,
  type PolicyRule,
  type PrivateTransferRequest,
  RAMP_PROVIDERS,
  RAMPS_MEMO_LIMITS,
} from "@sdp/types";
import { RAMP_FIAT_CURRENCIES } from "@sdp/types/generated/ramp-support";
import { getI64Encoder, getU64Encoder } from "@solana/kit";
import { z } from "zod";
import { SOL_MINT } from "@/services/payment-operation.service";

// Per-field schema for any payments input that expects a base58 Solana address
// (destination, referenceAddress, allowlist entries). Trim whitespace in a
// preprocess and require both the 32–44 length window and `isAddress` to pass.
// Validating here returns 400 BAD_REQUEST with an actionable per-field message
// instead of letting `assertValidAddress` throw a plain Error downstream (500).
function solanaAddressSchema(fieldName: string) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().refine((value) => value.length >= 32 && value.length <= 44 && isAddress(value), {
      message: `${fieldName} must be a base58 Solana address`,
    })
  );
}

// Payments token field: a well-known token symbol (SOL, USDC, ...) or a base58
// Solana mint address. Trim and case-fold symbols in a preprocess so validation
// matches `normalizePaymentToken` (which resolves well-known symbols to the
// configured cluster's mint). A single refine (rather than a union with
// `.min(32)`) avoids generic "String must contain at least 32 character(s)"
// errors for short inputs like `"BTC"`.
export const PAYMENT_TOKEN_VALIDATION_MESSAGE =
  "token must be a well-known token symbol (e.g. 'SOL', 'USDC') or a base58 Solana mint address";

const paymentTokenSchema = z.preprocess(
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
  operationFamily: z
    .enum(["transfer", "payment", "ramp", "issuance", "raw_sign", "program", "provider_admin"])
    .optional(),
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

const walletOperationFamilySchema = z.enum([
  "transfer",
  "payment",
  "ramp",
  "issuance",
  "raw_sign",
  "program",
  "provider_admin",
]);

const walletPolicyRuleSchema: z.ZodType<PolicyRule> = z.discriminatedUnion("kind", [
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("operation_family"),
    family: walletOperationFamilySchema.optional(),
    families: z.array(walletOperationFamilySchema).max(20).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("operation_type"),
    operationType: z.string().min(1, "operationType must not be empty").max(120).optional(),
    operationTypes: z
      .array(z.string().min(1, "operationTypes entries must not be empty").max(120))
      .max(100)
      .optional(),
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
    kind: z.literal("approval"),
    families: z.array(walletOperationFamilySchema).max(20).optional(),
    operationTypes: z.array(z.string().min(1).max(120)).max(100).optional(),
    assets: z.array(z.string().min(1).max(120)).max(100).optional(),
    approvalGroupId: z.string().min(1).max(120).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("always"),
  }),
]);

export const updateWalletPolicySchema = z.object({
  destinationAllowlist: z.array(solanaAddressSchema("destinationAllowlist entry")).max(500),
  maxTransferAmount: z
    .string()
    .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
    .optional(),
  maxDailyAmount: z
    .string()
    .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
    .optional(),
  defaultAction: z.enum(["allow", "deny", "approval_required", "review"]).optional(),
  rules: z.array(walletPolicyRuleSchema).max(100).optional(),
});

export const paymentAmountSchema = z
  .string()
  .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
  // Avoid adding a second error when the decimal-format check already failed.
  .refine((value) => !isDecimalString(value) || /[1-9]/.test(value), {
    message: "Amount must be greater than zero",
  });

const recurringTimestampSchema = z.string().datetime({ offset: true });
const futureRecurringTimestampSchema = (fieldName: string) =>
  recurringTimestampSchema.refine((value) => new Date(value).getTime() > Date.now(), {
    message: `${fieldName} must be in the future`,
  });
const firstCollectionAtTimestampSchema = futureRecurringTimestampSchema("firstCollectionAt");
const u64StringSchema = z
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
const i64StringSchema = z
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

export const subscriptionPlanIdParamsSchema = z.object({
  planId: z.string().min(1),
});

export const subscriptionIdParamsSchema = z.object({
  subscriptionId: z.string().min(1),
});

export const recurringPaymentIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const paymentSubscriptionPlanStatusSchema = z.enum(["draft", "active", "archived"]);

export const paymentSubscriptionStatusSchema = z.enum([
  "pending_authorization",
  "active",
  "paused",
  "canceling",
  "canceled",
  "expired",
]);

export const paymentSubscriptionCollectionAttemptStatusSchema = z.enum([
  "pending",
  "processing",
  "confirmed",
  "failed",
  "skipped",
]);

export const paymentRecurringPaymentStatusSchema = z.enum([
  "pending_activation",
  "activating",
  "active",
  "updating",
  "canceling",
  "resuming",
  "paused",
  "canceled",
  "expired",
]);

export const createRecurringPaymentSchema = z.object({
  sourceWalletId: z.string().min(1),
  counterpartyId: z.string().min(1),
  counterpartyAccountId: z.string().min(1),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  periodHours: z
    .number()
    .int()
    .positive()
    .max(24 * 365),
  firstCollectionAt: firstCollectionAtTimestampSchema.optional(),
  metadataUri: z.string().url().max(128).optional(),
});

export const updateRecurringPaymentSchema = z
  .object({
    sourceWalletId: z.string().min(1).optional(),
    counterpartyId: z.string().min(1).optional(),
    counterpartyAccountId: z.string().min(1).optional(),
    token: paymentTokenSchema.optional(),
    amount: paymentAmountSchema.optional(),
    periodHours: z
      .number()
      .int()
      .positive()
      .max(24 * 365)
      .optional(),
    firstCollectionAt: firstCollectionAtTimestampSchema.nullable().optional(),
    nextCollectionDueAt: recurringTimestampSchema.nullable().optional(),
    metadataUri: z.string().url().max(128).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  })
  .refine((value) => !value.counterpartyId || value.counterpartyAccountId, {
    message: "counterpartyAccountId is required when counterpartyId changes",
    path: ["counterpartyAccountId"],
  });

export const activateRecurringPaymentSchema = z.object({}).strict();
export const cancelRecurringPaymentSchema = z.object({}).strict();
export const collectRecurringPaymentSchema = z.object({}).strict();
export const resumeRecurringPaymentSchema = z.object({}).strict();

export const listRecurringPaymentsQuerySchema = z.object({
  counterpartyId: z.string().min(1).optional(),
  status: paymentRecurringPaymentStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const createSubscriptionPlanSchema = z.object({
  ownerWalletId: z.string().min(1),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  periodHours: z
    .number()
    .int()
    .positive()
    .max(24 * 365),
  programPlanId: u64StringSchema.optional(),
  planPda: solanaAddressSchema("planPda").optional(),
  destinationAddress: solanaAddressSchema("destinationAddress").optional(),
  pullerWalletId: z.string().min(1).optional(),
  metadataUri: z.string().url().max(128).optional(),
  status: paymentSubscriptionPlanStatusSchema.default("draft"),
});

export const updateSubscriptionPlanSchema = z
  .object({
    planPda: solanaAddressSchema("planPda").nullable().optional(),
    destinationAddress: solanaAddressSchema("destinationAddress").nullable().optional(),
    pullerWalletId: z.string().min(1).nullable().optional(),
    metadataUri: z.string().url().max(128).nullable().optional(),
    status: paymentSubscriptionPlanStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const prepareSubscriptionPlanCreateSchema = z.object({
  destinations: z.array(solanaAddressSchema("destinations entry")).max(4).optional(),
  pullers: z.array(solanaAddressSchema("pullers entry")).max(4).optional(),
  endTs: u64StringSchema.optional(),
  metadataUri: z.string().url().max(128).optional(),
});

export const listSubscriptionPlansQuerySchema = z.object({
  status: paymentSubscriptionPlanStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const createSubscriptionSchema = z.object({
  planId: z.string().min(1),
  counterpartyId: z.string().min(1),
  subscriberAddress: solanaAddressSchema("subscriberAddress"),
  subscriberTokenAccount: solanaAddressSchema("subscriberTokenAccount").optional(),
  subscriptionPda: solanaAddressSchema("subscriptionPda").optional(),
  subscriptionAuthorityAddress: solanaAddressSchema("subscriptionAuthorityAddress").optional(),
  authorizationSignature: z.string().min(1).max(128).optional(),
  status: paymentSubscriptionStatusSchema.default("pending_authorization"),
  currentPeriodStartAt: recurringTimestampSchema.optional(),
  nextCollectionDueAt: recurringTimestampSchema.optional(),
});

export const updateSubscriptionSchema = z
  .object({
    subscriberTokenAccount: solanaAddressSchema("subscriberTokenAccount").nullable().optional(),
    subscriptionPda: solanaAddressSchema("subscriptionPda").nullable().optional(),
    subscriptionAuthorityAddress: solanaAddressSchema("subscriptionAuthorityAddress")
      .nullable()
      .optional(),
    authorizationSignature: z.string().min(1).max(128).nullable().optional(),
    status: paymentSubscriptionStatusSchema.optional(),
    currentPeriodStartAt: recurringTimestampSchema.nullable().optional(),
    nextCollectionDueAt: recurringTimestampSchema.nullable().optional(),
    cancelAt: recurringTimestampSchema.nullable().optional(),
    canceledAt: recurringTimestampSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const prepareSubscriptionAuthorizationSchema = z.object({
  subscriberTokenAccount: solanaAddressSchema("subscriberTokenAccount"),
  expectedPlanCreatedAt: u64StringSchema,
  expectedSubscriptionAuthorityInitId: i64StringSchema,
});

export const prepareSubscriptionLifecycleSchema = z.object({});

export const listSubscriptionsQuerySchema = z.object({
  planId: z.string().min(1).optional(),
  counterpartyId: z.string().min(1).optional(),
  status: paymentSubscriptionStatusSchema.optional(),
  dueBefore: recurringTimestampSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const createSubscriptionCollectionAttemptSchema = z.object({
  amount: paymentAmountSchema.optional(),
  token: paymentTokenSchema.optional(),
  dueAt: recurringTimestampSchema.optional(),
  attemptedAt: recurringTimestampSchema.optional(),
  status: paymentSubscriptionCollectionAttemptStatusSchema.default("pending"),
  transferId: z.string().min(1).optional(),
  signature: z.string().min(1).max(128).optional(),
  error: z.string().min(1).max(2048).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const prepareSubscriptionCollectionSchema = z.object({
  amount: paymentAmountSchema.optional(),
  receiverTokenAccount: solanaAddressSchema("receiverTokenAccount"),
});

export const listSubscriptionCollectionAttemptsQuerySchema = z.object({
  status: paymentSubscriptionCollectionAttemptStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const magicBlockPrivateTransferOptionsSchema = z
  .object({
    validator: z.string().min(32).max(44).optional(),
    initIfMissing: z.boolean().optional(),
    initAtasIfMissing: z.boolean().optional(),
    initVaultIfMissing: z.boolean().optional(),
    minDelayMs: z
      .string()
      .regex(/^\d+$/, { message: "minDelayMs must be an integer string" })
      .optional(),
    maxDelayMs: z
      .string()
      .regex(/^\d+$/, { message: "maxDelayMs must be an integer string" })
      .optional(),
    clientRefId: z
      .string()
      .regex(/^\d+$/, { message: "clientRefId must be an integer string" })
      .optional(),
    split: z.number().int().min(1).max(15).optional(),
    gasless: z.boolean().optional(),
    legacy: z.boolean().optional(),
  })
  .strict();

export const privateTransferSchema: z.ZodType<PrivateTransferRequest> = z.object({
  provider: z.literal("magicblock"),
  magicBlock: magicBlockPrivateTransferOptionsSchema,
});

const rampProviderSchema = z.enum(RAMP_PROVIDERS);
export const rampDirectionSchema = z.enum(["onramp", "offramp"]);
const onrampCryptoRailSchema = z.enum(ONRAMP_CRYPTO_RAILS);
const offrampCryptoRailSchema = z.enum(OFFRAMP_CRYPTO_RAILS);

export const rampCurrencyCodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]+$/, { message: "Invalid ramp currency code" });
export const rampFiatCurrencySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(RAMP_FIAT_CURRENCIES)
);

export const cancelRampTransferSchema = z.object({
  provider: rampProviderSchema,
  providerReference: z.string().min(1),
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

export const createTransferSchema = z.object({
  projectId: z.string().min(1).optional(),
  source: z.string().min(1),
  destination: solanaAddressSchema("destination"),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  memo: z.string().max(256).optional(),
  privateTransfer: privateTransferSchema.optional(),
});

export const transferDirectionSchema = z.enum(["inbound", "outbound"]);

export const transferStatusSchema = z.enum([
  "pending",
  "processing",
  "confirmed",
  "finalized",
  "failed",
  "awaiting_payment",
  "settling",
  "completed",
  "canceled",
  "expired",
]);

const transferFilterTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const listTransfersQuerySchema = z.object({
  wallet: z.string().optional(),
  walletAddress: z.string().optional(),
  search: z
    .string()
    .trim()
    .max(200)
    .refine((value) => value.length === 0 || value.length >= 3, {
      message: "Search must be blank or contain at least 3 characters",
    })
    .optional(),
  token: z.string().optional(),
  direction: transferDirectionSchema.optional(),
  status: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(transferStatusSchema).min(1))
    .optional(),
  category: z.enum(["wallet", "ramp"]).optional(),
  type: z
    .string()
    .transform((value) => value.split(","))
    .pipe(
      z
        .array(z.enum(["transfer", "transfer_confidential", "transfer_batch", "onramp", "offramp"]))
        .min(1)
    )
    .optional(),
  counterpartyId: z.string().min(1).optional(),
  provider: rampProviderSchema.optional(),
  providerReference: z.string().min(1).optional(),
  from: transferFilterTimestampSchema.optional(),
  to: transferFilterTimestampSchema.optional(),
  includeObserved: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(true),
  sortBy: z.enum(["createdAt", "updatedAt", "amount", "status"]).default("createdAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const priorityFeeSchema = z.enum(["none", "low", "medium", "high", "auto"]);

export const transferBatchIdParamsSchema = z.object({
  batchId: z.string().min(1),
});

export const transferBatchStatusSchema = z.enum([
  "pending",
  "processing",
  "confirmed",
  "failed",
  "partially_failed",
  "archived",
]);

export const transferBatchRecipientStatusSchema = z.enum([
  "pending",
  "processing",
  "confirmed",
  "failed",
  "archived",
]);

export const transferBatchRecipientSchema = z.object({
  externalId: z.string().min(1).max(256).optional(),
  counterpartyId: z.string().min(1).optional(),
  counterpartyAccountId: z.string().min(1),
  amount: paymentAmountSchema,
});

export const transferBatchOptionsSchema = z.object({
  maxRecipientsPerTransaction: z.number().int().min(1).max(64).optional(),
  priorityFee: priorityFeeSchema.optional(),
  preflight: z.boolean().optional(),
});

export const createTransferBatchSchema = z.object({
  projectId: z.string().min(1).optional(),
  externalId: z.string().min(1).max(256).optional(),
  source: z.string().min(1),
  token: paymentTokenSchema,
  recipients: z.array(transferBatchRecipientSchema).min(1).max(500),
  options: transferBatchOptionsSchema.optional(),
});

export const estimateTransferBatchSchema = createTransferBatchSchema;

export const listTransferBatchesQuerySchema = z.object({
  wallet: z.string().optional(),
  token: z.string().optional(),
  status: transferBatchStatusSchema.optional(),
  externalId: z.string().min(1).max(256).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const estimateOnrampSchema = z.object({
  assetRail: onrampCryptoRailSchema,
  fiatCurrency: rampFiatCurrencySchema,
  fiatAmount: paymentAmountSchema,
});

export const estimateOfframpSchema = z.object({
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

export const createOnrampQuoteSchema = z.object({
  provider: rampProviderSchema,
  counterpartyId: z.string().min(1),
  destinationWallet: z.string().min(1),
  cryptoToken: rampCurrencyCodeSchema,
  fiatCurrency: rampFiatCurrencySchema,
  fiatAmount: paymentAmountSchema,
  redirectUrl: z.string().url().optional(),
  rampsMemo: rampsMemoSchema.optional(),
  // Embedding domain for Coinbase's Apple Pay payment link (browser origin host).
  domain: z.string().min(1).optional(),
});

const collectedDataSchema = z.record(z.string(), z.string()).optional();

export const submitCounterpartyRequirementsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("moonpay"), direction: rampDirectionSchema }),
  z.object({ provider: z.literal("moneygram"), direction: rampDirectionSchema }),
  z.discriminatedUnion("direction", [
    z.object({
      provider: z.literal("bvnk"),
      direction: z.literal("onramp"),
      cryptoToken: rampCurrencyCodeSchema,
      destinationWallet: z.string().min(1),
      fiatCurrency: rampFiatCurrencySchema,
      collectedData: collectedDataSchema,
    }),
    z.object({
      provider: z.literal("bvnk"),
      direction: z.literal("offramp"),
      cryptoToken: rampCurrencyCodeSchema,
      fiatCurrency: rampFiatCurrencySchema,
      collectedData: collectedDataSchema,
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
      fiatCurrency: rampFiatCurrencySchema,
      collectedData: collectedDataSchema,
    }),
  ]),
  z.object({ provider: z.literal("coinbase"), direction: rampDirectionSchema }),
  z.discriminatedUnion("direction", [
    z.object({
      provider: z.literal("mural"),
      direction: z.literal("onramp"),
      cryptoToken: rampCurrencyCodeSchema,
      destinationWallet: z.string().min(1),
      fiatCurrency: rampFiatCurrencySchema,
    }),
    z.object({
      provider: z.literal("mural"),
      direction: z.literal("offramp"),
      cryptoToken: rampCurrencyCodeSchema,
      fiatCurrency: rampFiatCurrencySchema,
    }),
  ]),
  z.object({ provider: z.literal("stripe"), direction: rampDirectionSchema }),
]);

export const createOfframpQuoteSchema = z.object({
  provider: rampProviderSchema,
  counterpartyId: z.string().min(1),
  sourceWallet: z.string().min(1),
  cryptoToken: rampCurrencyCodeSchema,
  fiatCurrency: rampFiatCurrencySchema.optional(),
  cryptoAmount: paymentAmountSchema,
  redirectUrl: z.string().url().optional(),
  rampsMemo: rampsMemoSchema.optional(),
});

export const moneygramRampEventSchema = z.discriminatedUnion("kind", [
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
  counterpartyId: z.string().min(1),
  amount: z.number().positive(),
  fiatCurrency: rampFiatCurrencySchema,
  cryptoToken: z.string().min(1),
  destinationWallet: z.string().min(1),
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
