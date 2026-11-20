import { z } from "zod";
import { SDP_ENVIRONMENTS } from "./api-keys";
import { EARN_SWAP_MAX_SLIPPAGE_BPS } from "./earn";
import { normalizeDecimalString } from "./idempotency";

/** Lifecycle of one economic intent, independent of its transaction attempts. */
export const OPERATION_STATUSES = [
  "prepared",
  "queued",
  "awaiting_signature",
  "submitted",
  "settling",
  "completed",
  "failed",
  "cancelled",
] as const;

/** Terminal observations never regress to an executable state. */
export const TERMINAL_OPERATION_STATUSES = ["completed", "failed", "cancelled"] as const;

/** The shared legal transition matrix; terminal states cannot reopen. */
export const OPERATION_TRANSITIONS = {
  prepared: ["queued", "awaiting_signature", "submitted", "failed", "cancelled"],
  queued: ["awaiting_signature", "submitted", "settling", "completed", "failed", "cancelled"],
  awaiting_signature: ["queued", "submitted", "settling", "completed", "failed", "cancelled"],
  submitted: ["settling", "completed", "failed", "cancelled"],
  settling: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<(typeof OPERATION_STATUSES)[number], readonly string[]>;

/** The supported initial operation families. */
export const OPERATION_KINDS = ["earn.deposit", "earn.withdraw"] as const;

const identifier = z.string().min(1).max(256);
const decimal = z
  .string()
  .max(128)
  .regex(/^\d+(?:\.\d+)?$/)
  .transform(normalizeDecimalString);
const positiveDecimal = decimal.refine((value) => /[1-9]/.test(value), "Amount must be positive");

/** Explicit token units; valuation in USD is a separate observation. */
export const operationAmountSchema = z.strictObject({ mint: identifier, value: decimal });

/** Use an owner address directly, or optionally select a connected wallet. */
export const operationSourceSchema = z.union([
  z.strictObject({
    ownerAddress: identifier.describe(
      "Your wallet address. Sign the returned transaction yourself; no SDP wallet registration or signing-provider configuration is required."
    ),
  }),
  z.strictObject({
    walletId: identifier.describe("Optional alternative: an SDP wallet with configured signing."),
  }),
]);

/** Every withdrawal quantity declares whether it names shares, tokens or held intermediate. */
export const operationWithdrawalAmountSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("shares"), value: positiveDecimal }),
  z.strictObject({ kind: z.literal("token"), mint: identifier, value: positiveDecimal }),
  z.strictObject({ kind: z.literal("intermediate"), mint: identifier, value: positiveDecimal }),
]);

/** Immutable caller-authorized economic input; arbitrary JSON is never executable intent. */
export const operationIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("earn.deposit"),
    strategyId: identifier,
    source: operationSourceSchema,
    amount: z.strictObject({ mint: identifier, value: positiveDecimal }),
    slippageBps: z.number().int().min(0).max(EARN_SWAP_MAX_SLIPPAGE_BPS).optional(),
    feePayer: identifier.optional(),
  }),
  z.strictObject({
    kind: z.literal("earn.withdraw"),
    positionId: z.string().min(1).max(1024),
    amount: operationWithdrawalAmountSchema,
    slippageBps: z.number().int().min(0).max(EARN_SWAP_MAX_SLIPPAGE_BPS).optional(),
    feePayer: identifier.optional(),
  }),
]);

/** A reference to the existing row that owns build, signing or settlement state. */
export const operationReferenceSchema = z.strictObject({ kind: identifier, id: identifier });

/** Private account binding retained for proposal recovery, never in the public DTO. */
export const operationProposalBindingSchema = z.strictObject({
  provider: z.literal("fireblocks"),
  externalId: identifier,
  connectionId: identifier,
  accountFingerprint: identifier,
  vaultAccountId: identifier,
  assetId: identifier,
  sourceAddress: identifier,
});
export type OperationProposalBinding = z.infer<typeof operationProposalBindingSchema>;

/** Quote observations are distinct from enforceable minimums and nullable unknown fees. */
export const operationTermsSchema = z.strictObject({
  inputAmount: operationAmountSchema.nullable().optional(),
  description: z.string().min(1).max(512).optional(),
  expiresAt: z.string().datetime().nullable(),
  estimate: operationAmountSchema.nullable(),
  minimum: operationAmountSchema.nullable(),
  fees: z
    .array(operationAmountSchema.extend({ kind: identifier.optional() }))
    .max(32)
    .nullable(),
  options: z
    .array(
      z.strictObject({
        id: identifier,
        label: z.string().min(1).max(256),
        settlement: z.enum(["instant", "delayed"]),
        estimatedSeconds: z.number().int().nonnegative().nullable(),
        mechanism: identifier.optional(),
        amount: operationAmountSchema.optional(),
        minimum: operationAmountSchema.nullable().optional(),
      })
    )
    .max(32),
});

/** The next explicit action; preparing or reading it never initiates signing. */
export const operationNextActionSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("sign_transaction"),
      transaction: z.string().min(1).max(1700),
      lastValidBlockHeight: z.string().regex(/^\d+$/),
      expiresAt: z.string().datetime().nullable(),
    })
    .describe(
      "Sign this exact transaction, then call /submit with signedTransaction and the current actionId/version. No SDP wallet setup is required."
    ),
  z
    .strictObject({ type: z.literal("submit") })
    .describe(
      "Connected walletId only. Call /submit with actionId/version and no signedTransaction to request configured signing."
    ),
  z
    .strictObject({ type: z.literal("select_option") })
    .describe(
      "Choose an advertised terms.options ID, then call /refresh with optionId and the current actionId/version. Review the returned transaction before submitting."
    ),
  z
    .strictObject({ type: z.literal("refresh") })
    .describe(
      "SDP has established safe replacement. Call /refresh with the current actionId/version, then review again. Never use refresh to bypass an unresolved timeout."
    ),
  z
    .strictObject({
      type: z.literal("sign_in_provider"),
      provider: identifier,
      providerTransactionId: identifier,
      instructions: z.string().min(1).max(2000),
      handoffUrl: z.url().nullable(),
    })
    .describe(
      "Connected walletId only. Follow the wallet provider's signing instructions, then poll this operation. Do not call /submit again."
    ),
  z
    .strictObject({ type: z.literal("wait"), reason: z.string().min(1).max(512) })
    .describe(
      "Poll this operation. Keep the same attempt; do not rebuild or resubmit different transaction bytes."
    ),
]);

/** Public operation state; credentials, initiating principals and signed bytes stay internal. */
export const operationSchema = z.strictObject({
  id: identifier,
  kind: z.enum(OPERATION_KINDS),
  status: z.enum(OPERATION_STATUSES),
  environment: z.enum(SDP_ENVIRONMENTS),
  intent: operationIntentSchema,
  actionId: identifier,
  version: z.number().int().positive(),
  nextAction: operationNextActionSchema.nullable(),
  terms: operationTermsSchema,
  buildRef: operationReferenceSchema.nullable(),
  resourceRef: operationReferenceSchema.nullable(),
  canCancel: z
    .boolean()
    .describe(
      "Whether state permits cancelling this preparation before any submission has been accepted. Does not grant permission or revoke exposed wallet transactions."
    ),
  cancelRequestedAt: z.string().datetime().nullable(),
  error: z.strictObject({ code: identifier, message: z.string().min(1).max(2000) }).nullable(),
  result: z
    .strictObject({
      positionId: identifier,
      strategyId: identifier.optional(),
      signature: z.string().nullable(),
      source: operationSourceSchema,
      settledAmount: operationAmountSchema.nullable(),
      settlementOutcome: z
        .enum(["delivered", "cancelled", "recovered"])
        .nullable()
        .describe("Recovered means strategy shares returned, not withdrawal proceeds."),
    })
    .nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Submission authorizes only the displayed transaction and terms version. */
export const submitOperationSchema = z.strictObject({
  actionId: identifier,
  version: z.number().int().positive(),
  signedTransaction: z
    .string()
    .min(1)
    .max(1700)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .optional()
    .describe(
      "Required for an ownerAddress source: the exact prepared transaction, base64 encoded and signed by its required signers. Omit for a connected walletId source, whose configured signer signs asynchronously."
    ),
});

/** Preparation stays bound to the current review; route selection never submits. */
export const refreshOperationSchema = submitOperationSchema
  .omit({ signedTransaction: true })
  .extend({ optionId: identifier.optional() });

/** Shared response for preparation, submission, refresh and cancellation. */
export const operationResponseSchema = z.strictObject({ operation: operationSchema });

/** Scoped history uses a stable cursor rather than returning an unbounded address book. */
export const operationsPageSchema = z.strictObject({
  operations: z.array(operationSchema),
  nextCursor: z.string().nullable(),
});

export type Operation = z.infer<typeof operationSchema>;
export type OperationKind = Operation["kind"];
export type OperationStatus = Operation["status"];
export type OperationIntent = z.infer<typeof operationIntentSchema>;
export type OperationSource = z.infer<typeof operationSourceSchema>;
export type OperationTerms = z.infer<typeof operationTermsSchema>;
export type OperationNextAction = z.infer<typeof operationNextActionSchema>;
export type OperationReference = z.infer<typeof operationReferenceSchema>;
export type SubmitOperation = z.infer<typeof submitOperationSchema>;
export type RefreshOperation = z.infer<typeof refreshOperationSchema>;
export type OperationResponse = z.infer<typeof operationResponseSchema>;
