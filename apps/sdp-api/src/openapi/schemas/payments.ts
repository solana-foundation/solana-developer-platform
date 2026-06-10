import { OFFRAMP_CRYPTO_RAILS, ONRAMP_CRYPTO_RAILS, RAMP_PROVIDERS } from "@sdp/types";
import {
  createOnrampQuoteSchema as createOnrampQuoteSchemaBase,
  createRecurringPaymentSchema as createRecurringPaymentSchemaBase,
  createSubscriptionCollectionAttemptSchema as createSubscriptionCollectionAttemptSchemaBase,
  createSubscriptionPlanSchema as createSubscriptionPlanSchemaBase,
  createSubscriptionSchema as createSubscriptionSchemaBase,
  createTransferSchema as createTransferSchemaBase,
  executeOfframpSchema as executeOfframpSchemaBase,
  executeOnrampSchema as executeOnrampSchemaBase,
  listOfframpCurrenciesQuerySchema as listOfframpCurrenciesQuerySchemaBase,
  listOnrampCurrenciesQuerySchema as listOnrampCurrenciesQuerySchemaBase,
  listRecurringPaymentsQuerySchema as listRecurringPaymentsQuerySchemaBase,
  listSubscriptionCollectionAttemptsQuerySchema as listSubscriptionCollectionAttemptsQuerySchemaBase,
  listSubscriptionPlansQuerySchema as listSubscriptionPlansQuerySchemaBase,
  listSubscriptionsQuerySchema as listSubscriptionsQuerySchemaBase,
  listTransfersQuerySchema as listTransfersQuerySchemaBase,
  paymentRecurringPaymentStatusSchema as paymentRecurringPaymentStatusSchemaBase,
  paymentSubscriptionCollectionAttemptStatusSchema as paymentSubscriptionCollectionAttemptStatusSchemaBase,
  paymentSubscriptionPlanStatusSchema as paymentSubscriptionPlanStatusSchemaBase,
  paymentSubscriptionStatusSchema as paymentSubscriptionStatusSchemaBase,
  prepareSubscriptionAuthorizationSchema as prepareSubscriptionAuthorizationSchemaBase,
  prepareSubscriptionCollectionSchema as prepareSubscriptionCollectionSchemaBase,
  prepareSubscriptionLifecycleSchema as prepareSubscriptionLifecycleSchemaBase,
  prepareSubscriptionPlanCreateSchema as prepareSubscriptionPlanCreateSchemaBase,
  prepareTransferOptionsSchema as prepareTransferOptionsSchemaBase,
  prepareTransferSchema as prepareTransferSchemaBase,
  priorityFeeSchema as priorityFeeSchemaBase,
  recurringPaymentIdParamsSchema as recurringPaymentIdParamsSchemaBase,
  simulateSandboxTransferSchema as simulateSandboxTransferSchemaBase,
  subscriptionIdParamsSchema as subscriptionIdParamsSchemaBase,
  subscriptionPlanIdParamsSchema as subscriptionPlanIdParamsSchemaBase,
  transferDirectionSchema as transferDirectionSchemaBase,
  transferIdParamsSchema as transferIdParamsSchemaBase,
  transferStatusSchema as transferStatusSchemaBase,
  updateSubscriptionPlanSchema as updateSubscriptionPlanSchemaBase,
  updateSubscriptionSchema as updateSubscriptionSchemaBase,
  updateWalletPolicySchema as updateWalletPolicySchemaBase,
  walletIdParamsSchema as walletIdParamsSchemaBase,
} from "../../routes/payments/schemas";
import {
  base64Schema,
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  solanaAddressSchema,
  transferIdParamSchema,
  walletIdParamSchema,
  withOpenApi,
  z,
} from "./base";
import { preparedTransactionSchema, simulationResultSchema } from "./issuance";

export const tokenAmountSchema = z.string().openapi({
  description: "Token amount in UI units (decimal string).",
  example: "100.00",
});

export const walletPolicySchema = z
  .object({
    walletId: walletIdParamSchema.openapi({
      description: "Custody wallet ID from /v1/wallets.",
      example: "wal_example",
    }),
    destinationAllowlist: z
      .array(solanaAddressSchema)
      .max(500)
      .openapi({
        description:
          "Allowed destination addresses. An empty array means no destination restrictions. Maximum 500 entries per wallet.",
        example: ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
      }),
    maxTransferAmount: tokenAmountSchema
      .optional()
      .openapi({ description: "Maximum amount allowed per transfer." }),
    maxDailyAmount: tokenAmountSchema
      .optional()
      .openapi({ description: "Maximum total amount allowed per day." }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Timestamp when the policy was created.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    updatedAt: isoDateTimeSchema.openapi({
      description: "Timestamp when the policy was last updated.",
      example: "2025-01-02T00:00:00.000Z",
    }),
  })
  .openapi({
    description:
      "Payment policy configuration for a custody-managed wallet. Wallet lifecycle belongs to /v1/wallets, while payment controls are internally stored as typed policy records.",
  });

export const paymentWalletIdParamsSchema = walletIdParamsSchemaBase
  .extend({
    walletId: withOpenApi(walletIdParamsSchemaBase.shape.walletId, {
      description: "Custody wallet ID from /v1/wallets.",
      example: "wal_example",
    }),
  })
  .openapi({ description: "Payment wallet path parameters." });

export const paymentTransferIdParamsSchema = transferIdParamsSchemaBase
  .extend({
    transferId: withOpenApi(transferIdParamsSchemaBase.shape.transferId, {
      description: "Transfer identifier (SDP record ID, not the on-chain signature).",
      example: "xfr_example",
    }),
  })
  .openapi({ description: "Payment transfer path parameters." });

export const updateWalletPolicyRequestSchema = updateWalletPolicySchemaBase
  .extend({
    destinationAllowlist: withOpenApi(updateWalletPolicySchemaBase.shape.destinationAllowlist, {
      description:
        "Allowed destination addresses. An empty array means no destination restrictions. Maximum 500 entries per wallet.",
      example: ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
    }),
    maxTransferAmount: withOpenApi(updateWalletPolicySchemaBase.shape.maxTransferAmount, {
      description: "Maximum amount allowed per transfer.",
      example: "100.00",
    }),
    maxDailyAmount: withOpenApi(updateWalletPolicySchemaBase.shape.maxDailyAmount, {
      description: "Maximum total amount allowed per day.",
      example: "1000.00",
    }),
  })
  .openapi({
    description:
      "Update wallet policy request payload. Controls map to typed internal policy records for provider-specific extensibility.",
  });

export const tokenBalanceSchema = z
  .object({
    token: z.string().openapi({ description: "Token symbol or mint address.", example: "USDC" }),
    mint: solanaAddressSchema.openapi({
      description: "Token mint address.",
      example: "So11111111111111111111111111111111111111112",
    }),
    amount: z.string().openapi({
      description: "Raw amount in smallest units.",
      example: "100000000",
    }),
    uiAmount: tokenAmountSchema,
    decimals: z.number().int().openapi({ description: "Token decimals.", example: 6 }),
    usdPrice: z.number().optional().openapi({
      description: "Resolved USD price per token when available.",
      example: 1,
    }),
    usdValue: z.number().optional().openapi({
      description: "Resolved USD value of this balance when pricing is available.",
      example: 100,
    }),
    confidential: z
      .boolean()
      .optional()
      .openapi({ description: "Confidential balance flag (when applicable).", example: false }),
  })
  .openapi({ description: "Token balance details." });

export const walletBalancesSchema = z
  .object({
    walletId: walletIdParamSchema.openapi({
      description: "Custody wallet ID from /v1/wallets.",
      example: "wal_example",
    }),
    address: solanaAddressSchema.openapi({ description: "Wallet address." }),
    balances: z.array(tokenBalanceSchema).openapi({ description: "Token balances." }),
  })
  .openapi({
    description:
      "Balance payload for a custody-managed wallet. Use /v1/wallets for wallet provisioning and listing.",
  });

export const magicBlockPrivateTransferOptionsSchema = z
  .object({
    validator: solanaAddressSchema.optional().openapi({
      description:
        "Optional MagicBlock validator pubkey. MagicBlock can resolve this when omitted.",
    }),
    initIfMissing: z
      .boolean()
      .optional()
      .openapi({ description: "Initialize the MagicBlock transfer queue when missing." }),
    initAtasIfMissing: z
      .boolean()
      .optional()
      .openapi({ description: "Initialize required associated token accounts when missing." }),
    initVaultIfMissing: z
      .boolean()
      .optional()
      .openapi({ description: "Initialize the MagicBlock vault when missing." }),
    minDelayMs: z.string().regex(/^\d+$/).optional().openapi({
      description:
        "Earliest settlement delay in milliseconds, preserved as MagicBlock's integer-string field.",
      example: "0",
    }),
    maxDelayMs: z.string().regex(/^\d+$/).optional().openapi({
      description:
        "Latest settlement delay in milliseconds, preserved as MagicBlock's integer-string field.",
      example: "1000",
    }),
    clientRefId: z.string().regex(/^\d+$/).optional().openapi({
      description:
        "Client reference encrypted by MagicBlock for payment correlation, preserved as an integer string.",
      example: "1042",
    }),
    split: z.number().int().min(1).max(15).optional().openapi({
      description: "Number of queue entries to split the transfer across.",
      example: 2,
    }),
    gasless: z
      .boolean()
      .optional()
      .openapi({ description: "Request MagicBlock fee sponsorship when supported." }),
    legacy: z
      .boolean()
      .optional()
      .openapi({ description: "Request MagicBlock legacy transaction mode instead of v0." }),
  })
  .strict()
  .openapi({
    description:
      "MagicBlock-specific options for private SPL transfer preparation. SDP currently supports base-balance private transfers only: funds are spent from the sender's normal Solana token balance and settle to the recipient's normal Solana token balance through MagicBlock's private routing.",
    example: {
      initIfMissing: true,
      initAtasIfMissing: true,
      maxDelayMs: "1000",
    },
  });

export const privateTransferRequestSchema = z
  .object({
    provider: z.literal("magicblock").openapi({
      description: "Private-transfer provider identifier.",
      example: "magicblock",
    }),
    magicBlock: magicBlockPrivateTransferOptionsSchema,
  })
  .openapi({
    description:
      "Optional private-transfer routing. MagicBlock can prepare an unsigned transaction for client review or execute through server-side custody when all required signers are SDP-controlled.",
  });

export const createTransferRequestSchema = createTransferSchemaBase
  .extend({
    projectId: withOpenApi(createTransferSchemaBase.shape.projectId, {
      description: "Project identifier for the transfer context.",
      example: "prj_example",
    }),
    source: withOpenApi(createTransferSchemaBase.shape.source, {
      description: "Source custody wallet ID from /v1/wallets.",
      example: "wal_example",
    }),
    destination: withOpenApi(createTransferSchemaBase.shape.destination, {
      description: "Destination wallet address.",
      example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    }),
    token: withOpenApi(createTransferSchemaBase.shape.token, {
      description:
        "Token mint address. For the native token, pass `SOL` (recommended) or the canonical SOL mint `So11111111111111111111111111111111111111112` — the server normalizes both to `SOL`. SPL tokens must be specified by their on-chain mint (symbols are not resolved at request time).",
      example: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    }),
    amount: withOpenApi(createTransferSchemaBase.shape.amount, {
      description: "Token amount in UI units (decimal string).",
      example: "100.00",
    }),
    memo: withOpenApi(createTransferSchemaBase.shape.memo, {
      description: "Optional memo for the transfer.",
    }),
    privateTransfer: privateTransferRequestSchema.optional().openapi({
      description:
        "Private-transfer routing. SDP asks the provider to build a base-balance private transfer, signs it with the custody wallet when required, and submits it on the configured Solana cluster.",
    }),
  })
  .openapi({
    description:
      "Create transfer request payload for a custody-managed source wallet. This endpoint does not provision wallets.",
  });

export const priorityFeeSchema = withOpenApi(priorityFeeSchemaBase, {
  description: "Priority fee level.",
  example: "auto",
});

export const prepareTransferOptionsSchema = prepareTransferOptionsSchemaBase
  .extend({
    priorityFee: withOpenApi(priorityFeeSchemaBase.optional(), {
      description: "Priority fee level (default: auto).",
      example: "auto",
    }),
    simulate: withOpenApi(prepareTransferOptionsSchemaBase.shape.simulate, {
      description: "Include simulation results in the response.",
      example: true,
    }),
  })
  .openapi({ description: "Transaction preparation options." });

export const prepareTransferRequestSchema = prepareTransferSchemaBase
  .extend({
    projectId: withOpenApi(prepareTransferSchemaBase.shape.projectId, {
      description: "Project identifier for the transfer context.",
      example: "prj_example",
    }),
    source: withOpenApi(prepareTransferSchemaBase.shape.source, {
      description: "Source custody wallet ID from /v1/wallets.",
      example: "wal_example",
    }),
    destination: withOpenApi(prepareTransferSchemaBase.shape.destination, {
      description: "Destination wallet address.",
      example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    }),
    token: withOpenApi(prepareTransferSchemaBase.shape.token, {
      description:
        "Token mint address. For the native token, pass `SOL` (recommended) or the canonical SOL mint `So11111111111111111111111111111111111111112` — the server normalizes both to `SOL`. SPL tokens must be specified by their on-chain mint (symbols are not resolved at request time).",
      example: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    }),
    amount: withOpenApi(prepareTransferSchemaBase.shape.amount, {
      description: "Token amount in UI units (decimal string).",
      example: "100.00",
    }),
    memo: withOpenApi(prepareTransferSchemaBase.shape.memo, {
      description: "Optional memo for the transfer.",
    }),
    referenceAddress: withOpenApi(prepareTransferSchemaBase.shape.referenceAddress, {
      description: "Optional reference address for tracking (Solana Pay reference account).",
      example: "RefY2HwGmCKvJsXJzhRkc7m9D4N6pQ5tT3aB8fE1uV2W",
    }),
    options: prepareTransferOptionsSchema.optional().openapi({
      description:
        "Transaction preparation options. Simulation is not supported when `privateTransfer` is present.",
      example: { priorityFee: "auto" },
    }),
    privateTransfer: privateTransferRequestSchema.optional().openapi({
      description:
        "Private-transfer routing for provider-built transaction preparation. MagicBlock private transfers are base-balance transfers routed privately by the provider.",
    }),
  })
  .openapi({
    description:
      "Prepare transfer request payload for a custody-managed source wallet. When privateTransfer is present, SDP asks the provider to build the unsigned transaction and returns it for client review/signing.",
  });

export const transferTypeSchema = z
  .enum(["transfer", "transfer_confidential", "onramp", "offramp"])
  .openapi({ description: "Transfer type.", example: "transfer" });

export const transferDirectionSchema = withOpenApi(transferDirectionSchemaBase, {
  description: "Transfer direction.",
  example: "outbound",
});

export const transferStatusSchema = withOpenApi(transferStatusSchemaBase, {
  description: "Transfer status.",
  example: "confirmed",
});

export const transferRiskLevelSchema = z
  .enum(["low", "medium", "high", "unknown"])
  .openapi({ description: "Risk level classification.", example: "low" });

export const transferRiskSchema = z
  .object({
    provider: z.string().openapi({ description: "Risk scoring provider.", example: "trm" }),
    score: z.string().openapi({ description: "Provider-specific risk score.", example: "0.12" }),
    level: transferRiskLevelSchema,
    evaluatedAt: isoDateTimeSchema.openapi({
      description: "Timestamp when risk was evaluated.",
      example: "2025-01-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Risk metadata for the transfer." });

export const transferInitiatorSchema = z
  .object({
    type: z
      .enum(["api_key", "user", "system"])
      .openapi({ description: "Initiator type.", example: "api_key" }),
    id: z.string().optional().openapi({ description: "Initiator identifier if applicable." }),
    display: z
      .string()
      .optional()
      .openapi({ description: "Human-friendly label for the initiator." }),
  })
  .openapi({ description: "Initiator metadata for the transfer." });

export const transferSchema = z
  .object({
    id: transferIdParamSchema,
    organizationId: orgIdParamSchema,
    projectId: projectIdParamSchema
      .optional()
      .openapi({ description: "Project identifier for the transfer." }),
    type: transferTypeSchema,
    direction: transferDirectionSchema,
    status: transferStatusSchema,
    signature: z.string().nullable().openapi({
      description: "Solana transaction signature (tx id/hash).",
      example: "sig_example",
    }),
    serializedTx: base64Schema.nullable().openapi({
      description: "Base64-encoded transaction payload, if available.",
      example: "base64_tx_example",
    }),
    slot: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Slot number, if confirmed.", example: 123456 }),
    blockTime: isoDateTimeSchema
      .nullable()
      .openapi({ description: "Block time, if confirmed.", example: "2025-01-01T00:00:00.000Z" }),
    fee: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Transaction fee in lamports.", example: 5000 }),
    error: z.string().nullable().openapi({
      description: "Error message if the transaction failed.",
      example: "Signature failed",
    }),
    initiatedBy: transferInitiatorSchema
      .optional()
      .openapi({ description: "Initiator that triggered the transfer." }),
    source: solanaAddressSchema.optional().openapi({ description: "Source wallet address." }),
    destination: solanaAddressSchema
      .optional()
      .openapi({ description: "Destination wallet address." }),
    memo: z
      .string()
      .max(256)
      .optional()
      .openapi({ description: "Optional memo for the transfer." }),
    token: z.string().optional().openapi({ description: "Token symbol or mint address." }),
    amount: tokenAmountSchema.optional(),
    provider: z.enum(RAMP_PROVIDERS).optional().openapi({
      description: "Ramp provider for on-ramp and off-ramp transfer records.",
      example: "moonpay",
    }),
    counterpartyId: z.string().optional().openapi({
      description: "Counterparty tied to a ramp transfer record.",
      example: "counterparty_example",
    }),
    providerReference: z.string().optional().openapi({
      description: "Provider quote or transaction reference used for ramp correlation.",
      example: "ramp_quote_example",
    }),
    deliveryMode: z.enum(["hosted", "manual_instructions"]).optional().openapi({
      description:
        "Ramp delivery mode. Hosted flows require the customer to complete a provider-hosted UI; manual instructions require the customer to fund displayed instructions.",
      example: "hosted",
    }),
    fiatCurrency: z.string().optional().openapi({
      description: "Fiat currency for the ramp leg.",
      example: "USD",
    }),
    fiatAmount: tokenAmountSchema.optional().openapi({
      description: "Fiat amount for the ramp leg when known.",
      example: "100.00",
    }),
    risk: transferRiskSchema
      .optional()
      .openapi({ description: "Optional risk evaluation for the transfer." }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    updatedAt: isoDateTimeSchema.openapi({
      description: "Last update timestamp.",
      example: "2025-01-02T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Transfer transaction record." });

export const preparedPrivateTransferSchema = z
  .object({
    provider: z.literal("magicblock").openapi({
      description: "Private-transfer provider that built the transaction.",
      example: "magicblock",
    }),
    magicBlock: z
      .object({
        kind: z
          .string()
          .openapi({ description: "MagicBlock transaction kind.", example: "transfer" }),
        version: z
          .string()
          .openapi({ description: "MagicBlock transaction version.", example: "v0" }),
        instructionCount: z.number().int().openapi({
          description: "Instruction count in the prepared transaction.",
          example: 4,
        }),
        requiredSigners: z.array(solanaAddressSchema).openapi({
          description: "Signers required by the MagicBlock-prepared transaction.",
        }),
        validator: solanaAddressSchema.optional().openapi({
          description: "MagicBlock validator pubkey returned by the provider, when present.",
        }),
      })
      .openapi({ description: "MagicBlock prepared-transfer metadata." }),
  })
  .openapi({ description: "Provider metadata returned for private-transfer preparation." });

export const prepareTransferResponseSchema = z
  .object({
    transfer: transferSchema.openapi({ description: "Transfer transaction record." }),
    preparedTransaction: preparedTransactionSchema.openapi({
      description: "Prepared transaction for client-side signing.",
    }),
    privateTransfer: preparedPrivateTransferSchema.optional().openapi({
      description:
        "Provider metadata returned for private-transfer preparation. The serialized transaction remains in preparedTransaction.",
    }),
    simulation: simulationResultSchema
      .optional()
      .openapi({ description: "Optional transaction simulation result." }),
  })
  .openapi({ description: "Prepare transfer response payload." });

export const paymentSubscriptionPlanStatusSchema = withOpenApi(
  paymentSubscriptionPlanStatusSchemaBase,
  {
    description: "Subscription plan status.",
    example: "active",
  }
);

export const paymentSubscriptionStatusSchema = withOpenApi(paymentSubscriptionStatusSchemaBase, {
  description: "Subscription status.",
  example: "active",
});

export const paymentSubscriptionCollectionAttemptStatusSchema = withOpenApi(
  paymentSubscriptionCollectionAttemptStatusSchemaBase,
  {
    description: "Collection attempt status.",
    example: "pending",
  }
);

export const paymentRecurringPaymentStatusSchema = withOpenApi(
  paymentRecurringPaymentStatusSchemaBase,
  {
    description: "Recurring payment status.",
    example: "active",
  }
);

export const paymentRecurringPaymentIdParamsSchema = recurringPaymentIdParamsSchemaBase
  .extend({
    id: withOpenApi(recurringPaymentIdParamsSchemaBase.shape.id, {
      description: "SDP recurring payment record ID.",
      example: "prp_example",
    }),
  })
  .openapi({ description: "Recurring payment path parameters." });

export const paymentSubscriptionPlanIdParamsSchema = subscriptionPlanIdParamsSchemaBase
  .extend({
    planId: withOpenApi(subscriptionPlanIdParamsSchemaBase.shape.planId, {
      description: "SDP subscription plan record ID.",
      example: "psp_example",
    }),
  })
  .openapi({ description: "Subscription plan path parameters." });

export const paymentSubscriptionIdParamsSchema = subscriptionIdParamsSchemaBase
  .extend({
    subscriptionId: withOpenApi(subscriptionIdParamsSchemaBase.shape.subscriptionId, {
      description: "SDP subscription record ID.",
      example: "psub_example",
    }),
  })
  .openapi({ description: "Subscription path parameters." });

export const createRecurringPaymentRequestSchema = createRecurringPaymentSchemaBase
  .extend({
    sourceWalletId: withOpenApi(createRecurringPaymentSchemaBase.shape.sourceWalletId, {
      description: "SDP custody wallet that will fund the recurring payment.",
      example: "wal_source",
    }),
    counterpartyId: withOpenApi(createRecurringPaymentSchemaBase.shape.counterpartyId, {
      description: "Counterparty receiving the recurring payment.",
      example: "cp_example",
    }),
    counterpartyAccountId: withOpenApi(
      createRecurringPaymentSchemaBase.shape.counterpartyAccountId,
      {
        description: "Counterparty crypto_wallet account. It must contain Solana wallet details.",
        example: "cpa_example",
      }
    ),
    token: withOpenApi(createRecurringPaymentSchemaBase.shape.token, {
      description:
        "SPL token mint address. Native SOL is not supported for program-backed recurring payments.",
      example: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    }),
    amount: withOpenApi(createRecurringPaymentSchemaBase.shape.amount, {
      description: "Recurring payment amount in UI units.",
      example: "25.00",
    }),
    periodHours: withOpenApi(createRecurringPaymentSchemaBase.shape.periodHours, {
      description: "Billing period length in hours.",
      example: 720,
    }),
    firstCollectionAt: withOpenApi(createRecurringPaymentSchemaBase.shape.firstCollectionAt, {
      description: "Optional first collection timestamp. Defaults to activation time when omitted.",
      example: "2099-01-01T00:00:00.000Z",
    }),
    metadataUri: withOpenApi(createRecurringPaymentSchemaBase.shape.metadataUri, {
      description: "Optional plan metadata URI.",
      example: "https://example.com/subscriptions/monthly-usdc.json",
    }),
  })
  .openapi({
    description:
      "Creates an SDP-custody outbound recurring payment intent. Activation and collection are added by follow-up endpoints.",
  });

export const paymentListRecurringPaymentsQuerySchema = listRecurringPaymentsQuerySchemaBase
  .extend({
    counterpartyId: withOpenApi(listRecurringPaymentsQuerySchemaBase.shape.counterpartyId, {
      description: "Filter recurring payments by counterparty.",
      example: "cp_example",
    }),
    status: paymentRecurringPaymentStatusSchema.optional(),
  })
  .openapi({ description: "Recurring payment list filters." });

export const paymentRecurringPaymentSchema = z
  .object({
    id: z.string().openapi({ description: "SDP recurring payment ID.", example: "prp_example" }),
    organizationId: orgIdParamSchema,
    projectId: projectIdParamSchema,
    sourceWalletId: walletIdParamSchema.openapi({
      description: "SDP custody wallet that funds the recurring payment.",
    }),
    sourceAddress: solanaAddressSchema.openapi({
      description: "Source wallet address.",
    }),
    counterpartyId: z.string().openapi({ description: "Counterparty ID.", example: "cp_example" }),
    counterpartyAccountId: z
      .string()
      .openapi({ description: "Counterparty account ID.", example: "cpa_example" }),
    destinationAddress: solanaAddressSchema.openapi({
      description: "Counterparty wallet owner address.",
    }),
    destinationTokenAccount: solanaAddressSchema
      .nullable()
      .openapi({ description: "Derived counterparty token account used for collection." }),
    token: z.string().openapi({ description: "SPL token mint address." }),
    amount: tokenAmountSchema,
    periodHours: z.number().int().positive().openapi({ example: 720 }),
    firstCollectionAt: isoDateTimeSchema
      .nullable()
      .openapi({ description: "Requested first collection timestamp." }),
    nextCollectionDueAt: isoDateTimeSchema
      .nullable()
      .openapi({ description: "Next due collection timestamp." }),
    planId: z.string().nullable().openapi({ description: "Linked SDP subscription plan ID." }),
    subscriptionId: z.string().nullable().openapi({ description: "Linked SDP subscription ID." }),
    planPda: solanaAddressSchema.nullable().openapi({ description: "On-chain plan PDA." }),
    planCreatedAt: z
      .string()
      .nullable()
      .openapi({ description: "On-chain plan createdAt value as an unsigned integer string." }),
    planCreationSignature: z
      .string()
      .nullable()
      .openapi({ description: "Solana signature for plan creation." }),
    subscriptionPda: solanaAddressSchema
      .nullable()
      .openapi({ description: "On-chain subscription PDA." }),
    subscriptionAuthorityAddress: solanaAddressSchema
      .nullable()
      .openapi({ description: "On-chain subscription authority address." }),
    authorizationSignature: z
      .string()
      .nullable()
      .openapi({ description: "Solana signature for subscription authorization." }),
    status: paymentRecurringPaymentStatusSchema,
    metadataUri: z.string().nullable().openapi({ description: "Optional plan metadata URI." }),
    createdBy: z.string().nullable().openapi({ description: "Creator user ID or API key ID." }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .openapi({ description: "SDP-custody outbound recurring payment record." });

export const paymentRecurringPaymentResponseSchema = z
  .object({
    recurringPayment: paymentRecurringPaymentSchema,
  })
  .openapi({ description: "Recurring payment response payload." });

export const paymentRecurringPaymentListResponseSchema = z
  .object({
    recurringPayments: z.array(paymentRecurringPaymentSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi({ description: "Recurring payment list response payload." });

export const createSubscriptionPlanRequestSchema = createSubscriptionPlanSchemaBase
  .extend({
    ownerWalletId: withOpenApi(createSubscriptionPlanSchemaBase.shape.ownerWalletId, {
      description: "Custody wallet that owns the Solana subscription plan.",
      example: "wal_merchant",
    }),
    token: withOpenApi(createSubscriptionPlanSchemaBase.shape.token, {
      description:
        "Token mint address. Native SOL is not expected for program-backed subscriptions.",
      example: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    }),
    amount: withOpenApi(createSubscriptionPlanSchemaBase.shape.amount, {
      description: "Recurring charge amount in UI units.",
      example: "25.00",
    }),
    periodHours: withOpenApi(createSubscriptionPlanSchemaBase.shape.periodHours, {
      description: "Billing period length in hours.",
      example: 720,
    }),
    programPlanId: withOpenApi(createSubscriptionPlanSchemaBase.shape.programPlanId, {
      description:
        "Unsigned 64-bit decimal program plan identifier used in the Solana subscriptions PDA seed. Defaults to a generated nonzero value.",
      example: "17014118346046923173",
    }),
    planPda: withOpenApi(createSubscriptionPlanSchemaBase.shape.planPda, {
      description: "On-chain plan PDA once created.",
      example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    }),
    destinationAddress: withOpenApi(createSubscriptionPlanSchemaBase.shape.destinationAddress, {
      description: "Optional destination owner address allowed by the on-chain plan.",
      example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    }),
    pullerWalletId: withOpenApi(createSubscriptionPlanSchemaBase.shape.pullerWalletId, {
      description: "Optional SDP custody wallet allowed to pull subscription payments.",
      example: "wal_collector",
    }),
    metadataUri: withOpenApi(createSubscriptionPlanSchemaBase.shape.metadataUri, {
      description: "Optional plan metadata URI.",
      example: "https://example.com/subscriptions/monthly-usdc.json",
    }),
    status: paymentSubscriptionPlanStatusSchema.optional(),
  })
  .openapi({
    description:
      "Creates an SDP subscription plan record. Prepare the on-chain Solana subscriptions program transaction separately with the plan prepare endpoint.",
  });

export const updateSubscriptionPlanRequestSchema = updateSubscriptionPlanSchemaBase
  .safeExtend({
    planPda: withOpenApi(updateSubscriptionPlanSchemaBase.shape.planPda, {
      description: "On-chain plan PDA, or null to clear it.",
      example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    }),
    destinationAddress: withOpenApi(updateSubscriptionPlanSchemaBase.shape.destinationAddress, {
      description: "Destination owner address, or null to clear it.",
    }),
    pullerWalletId: withOpenApi(updateSubscriptionPlanSchemaBase.shape.pullerWalletId, {
      description: "Collection wallet ID, or null to clear it.",
      example: "wal_collector",
    }),
    metadataUri: withOpenApi(updateSubscriptionPlanSchemaBase.shape.metadataUri, {
      description: "Plan metadata URI, or null to clear it.",
    }),
    status: paymentSubscriptionPlanStatusSchema.optional(),
  })
  .openapi({ description: "Updates mutable SDP subscription plan fields." });

export const paymentListSubscriptionPlansQuerySchema = listSubscriptionPlansQuerySchemaBase
  .extend({
    status: paymentSubscriptionPlanStatusSchema.optional(),
  })
  .openapi({ description: "Subscription plan list filters." });

export const paymentSubscriptionPlanSchema = z
  .object({
    id: z.string().openapi({ description: "SDP subscription plan ID.", example: "psp_example" }),
    organizationId: orgIdParamSchema,
    projectId: projectIdParamSchema,
    ownerWalletId: walletIdParamSchema,
    ownerAddress: solanaAddressSchema,
    token: z.string().openapi({ description: "Token mint or normalized token identifier." }),
    amount: tokenAmountSchema,
    periodHours: z.number().int().positive().openapi({ example: 720 }),
    programPlanId: z.string().openapi({
      description: "Unsigned 64-bit decimal program plan identifier used in PDA derivation.",
      example: "17014118346046923173",
    }),
    planPda: solanaAddressSchema.nullable().openapi({ description: "On-chain plan PDA." }),
    destinationAddress: solanaAddressSchema
      .nullable()
      .openapi({ description: "Allowed destination owner address." }),
    pullerWalletId: walletIdParamSchema.nullable().openapi({ description: "Collector wallet ID." }),
    pullerAddress: solanaAddressSchema
      .nullable()
      .openapi({ description: "Collector wallet address." }),
    metadataUri: z.string().nullable().openapi({ description: "Optional plan metadata URI." }),
    status: paymentSubscriptionPlanStatusSchema,
    createdBy: z.string().nullable().openapi({ description: "Creator user ID or API key ID." }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .openapi({ description: "Recurring payment subscription plan record." });

export const paymentSubscriptionPlanResponseSchema = z
  .object({
    subscriptionPlan: paymentSubscriptionPlanSchema,
  })
  .openapi({ description: "Subscription plan response payload." });

export const preparedSubscriptionTransactionSchema = preparedTransactionSchema
  .extend({
    requiredSigners: z.array(solanaAddressSchema).openapi({
      description:
        "Addresses that must sign the prepared transaction. This includes the sponsored fee payer when the transaction uses one.",
    }),
  })
  .openapi({
    description: "Unsigned Solana subscriptions transaction payload for client-side signing.",
  });

export const prepareSubscriptionPlanCreateRequestSchema = prepareSubscriptionPlanCreateSchemaBase
  .extend({
    destinations: withOpenApi(prepareSubscriptionPlanCreateSchemaBase.shape.destinations, {
      description:
        "Allowed destination addresses for the on-chain plan. Defaults to the stored plan destination.",
    }),
    pullers: withOpenApi(prepareSubscriptionPlanCreateSchemaBase.shape.pullers, {
      description:
        "Allowed puller addresses for the on-chain plan. Defaults to the stored puller or owner address.",
    }),
    endTs: withOpenApi(prepareSubscriptionPlanCreateSchemaBase.shape.endTs, {
      description: "Optional unsigned 64-bit Unix timestamp when the on-chain plan ends.",
      example: "1770000000",
    }),
    metadataUri: withOpenApi(prepareSubscriptionPlanCreateSchemaBase.shape.metadataUri, {
      description: "Optional metadata URI to embed in the on-chain plan.",
      example: "https://example.com/subscriptions/monthly-usdc.json",
    }),
  })
  .openapi({
    description:
      "Optional overrides used when preparing the Solana subscriptions create-plan transaction.",
  });

export const preparePaymentSubscriptionPlanResponseSchema = z
  .object({
    subscriptionPlan: paymentSubscriptionPlanSchema,
    planPda: solanaAddressSchema.openapi({
      description: "Derived Solana subscriptions plan PDA.",
    }),
    preparedTransaction: preparedSubscriptionTransactionSchema,
  })
  .openapi({ description: "Prepared Solana subscriptions create-plan response payload." });

export const paymentSubscriptionPlanListResponseSchema = z
  .object({
    subscriptionPlans: z.array(paymentSubscriptionPlanSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi({ description: "Subscription plan list response payload." });

export const createSubscriptionRequestSchema = createSubscriptionSchemaBase
  .extend({
    planId: withOpenApi(createSubscriptionSchemaBase.shape.planId, {
      description: "SDP subscription plan ID.",
      example: "psp_example",
    }),
    counterpartyId: withOpenApi(createSubscriptionSchemaBase.shape.counterpartyId, {
      description: "Counterparty being billed for the recurring payment.",
      example: "counterparty_example",
    }),
    subscriberAddress: withOpenApi(createSubscriptionSchemaBase.shape.subscriberAddress, {
      description: "Customer wallet address that authorizes the subscription.",
      example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    }),
    subscriberTokenAccount: withOpenApi(createSubscriptionSchemaBase.shape.subscriberTokenAccount, {
      description: "Optional subscriber token account address.",
    }),
    subscriptionPda: withOpenApi(createSubscriptionSchemaBase.shape.subscriptionPda, {
      description: "On-chain subscription PDA once created.",
    }),
    subscriptionAuthorityAddress: withOpenApi(
      createSubscriptionSchemaBase.shape.subscriptionAuthorityAddress,
      {
        description: "Subscription authority PDA/address once initialized.",
      }
    ),
    authorizationSignature: withOpenApi(createSubscriptionSchemaBase.shape.authorizationSignature, {
      description: "Signature for the customer authorization transaction.",
      example: "sig_example",
    }),
    status: paymentSubscriptionStatusSchema.optional(),
  })
  .openapi({
    description:
      "Creates an SDP subscription record tied to a counterparty. The customer must still sign the Solana subscription authorization flow.",
  });

export const updateSubscriptionRequestSchema = updateSubscriptionSchemaBase
  .safeExtend({
    status: paymentSubscriptionStatusSchema.optional(),
  })
  .openapi({ description: "Updates mutable subscription state and on-chain identifiers." });

export const paymentListSubscriptionsQuerySchema = listSubscriptionsQuerySchemaBase
  .extend({
    status: paymentSubscriptionStatusSchema.optional(),
  })
  .openapi({ description: "Subscription list filters." });

export const paymentSubscriptionSchema = z
  .object({
    id: z.string().openapi({ description: "SDP subscription ID.", example: "psub_example" }),
    organizationId: orgIdParamSchema,
    projectId: projectIdParamSchema,
    planId: z.string().openapi({ description: "SDP subscription plan ID." }),
    counterpartyId: z.string().openapi({ description: "Counterparty ID." }),
    subscriberAddress: solanaAddressSchema,
    subscriberTokenAccount: solanaAddressSchema
      .nullable()
      .openapi({ description: "Subscriber token account address." }),
    subscriptionPda: solanaAddressSchema
      .nullable()
      .openapi({ description: "On-chain subscription PDA." }),
    subscriptionAuthorityAddress: solanaAddressSchema
      .nullable()
      .openapi({ description: "On-chain subscription authority address." }),
    authorizationSignature: z
      .string()
      .nullable()
      .openapi({ description: "Customer authorization transaction signature." }),
    status: paymentSubscriptionStatusSchema,
    currentPeriodStartAt: isoDateTimeSchema.nullable(),
    nextCollectionDueAt: isoDateTimeSchema.nullable(),
    cancelAt: isoDateTimeSchema.nullable(),
    canceledAt: isoDateTimeSchema.nullable(),
    createdBy: z.string().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .openapi({ description: "Recurring payment subscription record." });

export const paymentSubscriptionResponseSchema = z
  .object({
    subscription: paymentSubscriptionSchema,
  })
  .openapi({ description: "Subscription response payload." });

export const prepareSubscriptionAuthorizationRequestSchema =
  prepareSubscriptionAuthorizationSchemaBase
    .extend({
      subscriberTokenAccount: withOpenApi(
        prepareSubscriptionAuthorizationSchemaBase.shape.subscriberTokenAccount,
        {
          description:
            "Subscriber token account that authorizes the subscription authority delegation.",
          example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        }
      ),
      expectedPlanCreatedAt: withOpenApi(
        prepareSubscriptionAuthorizationSchemaBase.shape.expectedPlanCreatedAt,
        {
          description:
            "Unsigned 64-bit created-at timestamp from the on-chain plan terms that the subscriber consents to.",
          example: "0",
        }
      ),
      expectedSubscriptionAuthorityInitId: withOpenApi(
        prepareSubscriptionAuthorizationSchemaBase.shape.expectedSubscriptionAuthorityInitId,
        {
          description:
            "Signed 64-bit init id from the on-chain subscription authority that the subscriber consents to.",
          example: "0",
        }
      ),
    })
    .openapi({
      description:
        "Inputs for preparing the subscriber-signed Solana subscription authorization transaction.",
    });

export const prepareSubscriptionLifecycleRequestSchema = prepareSubscriptionLifecycleSchemaBase
  .extend({})
  .openapi({
    description:
      "Empty request body for preparing subscriber-signed subscription lifecycle transactions.",
  });

export const preparePaymentSubscriptionAuthorizationResponseSchema = z
  .object({
    subscription: paymentSubscriptionSchema,
    subscriptionPda: solanaAddressSchema.openapi({
      description: "Derived subscription delegation PDA.",
    }),
    subscriptionAuthorityAddress: solanaAddressSchema.openapi({
      description: "Derived subscription authority PDA.",
    }),
    preparedTransaction: preparedSubscriptionTransactionSchema,
  })
  .openapi({ description: "Prepared subscription authorization response payload." });

export const preparePaymentSubscriptionLifecycleResponseSchema = z
  .object({
    subscription: paymentSubscriptionSchema,
    preparedTransaction: preparedSubscriptionTransactionSchema,
  })
  .openapi({ description: "Prepared subscription lifecycle response payload." });

export const paymentSubscriptionListResponseSchema = z
  .object({
    subscriptions: z.array(paymentSubscriptionSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi({ description: "Subscription list response payload." });

export const createSubscriptionCollectionAttemptRequestSchema =
  createSubscriptionCollectionAttemptSchemaBase
    .extend({
      status: paymentSubscriptionCollectionAttemptStatusSchema.optional(),
    })
    .openapi({
      description:
        "Creates a collection-attempt record for a due subscription. This endpoint records backend state; the collection worker/Solana transaction submitter owns actual settlement.",
    });

export const paymentListSubscriptionCollectionAttemptsQuerySchema =
  listSubscriptionCollectionAttemptsQuerySchemaBase
    .extend({
      status: paymentSubscriptionCollectionAttemptStatusSchema.optional(),
    })
    .openapi({ description: "Collection attempt list filters." });

export const paymentSubscriptionCollectionAttemptSchema = z
  .object({
    id: z.string().openapi({ description: "Collection attempt ID.", example: "psca_example" }),
    organizationId: orgIdParamSchema,
    projectId: projectIdParamSchema,
    subscriptionId: z.string().openapi({ description: "Subscription ID." }),
    transferId: transferIdParamSchema
      .nullable()
      .openapi({ description: "Payment transfer record ID when linked." }),
    token: z.string().openapi({ description: "Token mint or normalized token identifier." }),
    amount: tokenAmountSchema,
    dueAt: isoDateTimeSchema,
    attemptedAt: isoDateTimeSchema.nullable(),
    status: paymentSubscriptionCollectionAttemptStatusSchema,
    signature: z.string().nullable().openapi({ description: "Solana transaction signature." }),
    error: z.string().nullable().openapi({ description: "Collection error, if any." }),
    metadata: z.record(z.string(), z.unknown()).openapi({
      description: "Provider/job metadata for the attempt.",
    }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .openapi({ description: "Recurring payment collection attempt record." });

export const paymentSubscriptionCollectionAttemptResponseSchema = z
  .object({
    collectionAttempt: paymentSubscriptionCollectionAttemptSchema,
  })
  .openapi({ description: "Collection attempt response payload." });

export const prepareSubscriptionCollectionRequestSchema = prepareSubscriptionCollectionSchemaBase
  .extend({
    amount: withOpenApi(prepareSubscriptionCollectionSchemaBase.shape.amount, {
      description:
        "Optional override amount in UI units. Defaults to the subscription plan amount.",
      example: "25.00",
    }),
    receiverTokenAccount: withOpenApi(
      prepareSubscriptionCollectionSchemaBase.shape.receiverTokenAccount,
      {
        description:
          "Receiver token account for the pulled subscription payment. It must be allowed by the on-chain plan.",
        example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      }
    ),
  })
  .openapi({
    description:
      "Inputs for preparing the collector-signed Solana subscriptions transfer transaction.",
  });

export const preparePaymentSubscriptionCollectionResponseSchema = z
  .object({
    subscription: paymentSubscriptionSchema,
    preparedTransaction: preparedSubscriptionTransactionSchema,
    collectionAttempt: paymentSubscriptionCollectionAttemptSchema.optional(),
  })
  .openapi({ description: "Prepared subscription collection response payload." });

export const paymentSubscriptionCollectionAttemptListResponseSchema = z
  .object({
    collectionAttempts: z.array(paymentSubscriptionCollectionAttemptSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi({ description: "Collection attempt list response payload." });

export const executeOnrampRequestSchema = executeOnrampSchemaBase
  .extend({
    provider: withOpenApi(executeOnrampSchemaBase.shape.provider, {
      description:
        "Ramp provider identifier. Explicit provider selection is required because each provider has different flow requirements.",
      example: "moonpay",
    }),
    counterpartyId: withOpenApi(executeOnrampSchemaBase.shape.counterpartyId, {
      description:
        "Counterparty identifier. Required for Lightspark to resolve the Grid customer that funds the quote.",
      example: "cp_example",
    }),
    destinationWallet: withOpenApi(executeOnrampSchemaBase.shape.destinationWallet, {
      description: "Destination wallet ID or Solana address for purchased crypto.",
      example: "wal_example",
    }),
    cryptoToken: withOpenApi(executeOnrampSchemaBase.shape.cryptoToken, {
      description:
        "Crypto token symbol or provider currency code. Simple symbols like `USDC` and `SOL` are normalized server-side for supported providers.",
      example: "USDC",
    }),
    fiatCurrency: withOpenApi(executeOnrampSchemaBase.shape.fiatCurrency, {
      description: "Fiat currency for on-ramp.",
      example: "USD",
    }),
    fiatAmount: withOpenApi(executeOnrampSchemaBase.shape.fiatAmount, {
      description:
        "Fiat amount to purchase crypto with. MoonPay on-ramp requires at least 20 units of the selected fiat currency.",
      example: "100.00",
    }),
    redirectUrl: withOpenApi(executeOnrampSchemaBase.shape.redirectUrl, {
      description: "Optional redirect URL after provider flow completes.",
    }),
    bvnkCompliance: withOpenApi(executeOnrampSchemaBase.shape.bvnkCompliance, {
      description:
        "BVNK-only compliance details. Optional on BVNK on-ramp; required on BVNK off-ramp (which validates that `partyDetails` has at least one entry). Omit the field entirely for `moonpay` and `lightspark`.",
      example: { partyDetails: [{ type: "individual" }] },
    }),
  })
  .openapi({
    description:
      'Execute on-ramp request payload. Note: BVNK on-ramp requires additional provider-side account enablement and compliance setup beyond API credentials. The default example is shaped for `provider: "moonpay"`; switch `provider` to `bvnk` to attach `bvnkCompliance.partyDetails`.',
    example: {
      provider: "moonpay",
      counterpartyId: "cp_example",
      destinationWallet: "wal_example",
      cryptoToken: "USDC",
      fiatCurrency: "USD",
      fiatAmount: "100.00",
      redirectUrl: "https://example.com",
    },
  });

export const createOnrampQuoteRequestSchema = createOnrampQuoteSchemaBase
  .extend({
    provider: withOpenApi(createOnrampQuoteSchemaBase.shape.provider, {
      description:
        "Ramp provider identifier. MoonPay returns a hosted widget URL; Lightspark returns manual funding instructions.",
      example: "moonpay",
    }),
    counterpartyId: withOpenApi(createOnrampQuoteSchemaBase.shape.counterpartyId, {
      description:
        "SDP counterparty ID. Provider-native customer records may be resolved or created from this counterparty.",
      example: "counterparty_example",
    }),
    destinationWallet: withOpenApi(createOnrampQuoteSchemaBase.shape.destinationWallet, {
      description: "Destination wallet ID or Solana address for purchased crypto.",
      example: "wal_example",
    }),
    cryptoToken: withOpenApi(createOnrampQuoteSchemaBase.shape.cryptoToken, {
      description: "Crypto token symbol or provider currency code.",
      example: "USDC",
    }),
    fiatCurrency: withOpenApi(createOnrampQuoteSchemaBase.shape.fiatCurrency, {
      description: "Fiat currency for on-ramp.",
      example: "USD",
    }),
    fiatAmount: withOpenApi(createOnrampQuoteSchemaBase.shape.fiatAmount, {
      description: "Fiat amount to on-ramp.",
      example: "100.00",
    }),
    redirectUrl: withOpenApi(createOnrampQuoteSchemaBase.shape.redirectUrl, {
      description: "Optional return URL after hosted provider flow completes.",
      example: "https://example.com/onramp/complete",
    }),
  })
  .openapi({
    description:
      "Create an on-ramp quote. The response uses `deliveryMode` to indicate whether the client should display manual instructions or open a hosted provider flow.",
    example: {
      provider: "moonpay",
      counterpartyId: "counterparty_example",
      destinationWallet: "wal_example",
      cryptoToken: "USDC",
      fiatCurrency: "USD",
      fiatAmount: "100.00",
      redirectUrl: "https://example.com/onramp/complete",
    },
  });

export const executeOfframpRequestSchema = executeOfframpSchemaBase
  .extend({
    provider: withOpenApi(executeOfframpSchemaBase.shape.provider, {
      description:
        "Ramp provider identifier. Explicit provider selection is required because each provider has different flow requirements.",
      example: "moonpay",
    }),
    sourceWallet: withOpenApi(executeOfframpSchemaBase.shape.sourceWallet, {
      description: "Source wallet ID or Solana address for crypto-to-fiat off-ramp.",
      example: "wal_example",
    }),
    cryptoToken: withOpenApi(executeOfframpSchemaBase.shape.cryptoToken, {
      description:
        "Crypto token symbol or provider currency code. Simple symbols like `USDC` and `SOL` are normalized server-side for supported providers.",
      example: "USDC",
    }),
    fiatCurrency: withOpenApi(executeOfframpSchemaBase.shape.fiatCurrency, {
      description: "Fiat payout currency.",
      example: "USD",
    }),
    cryptoAmount: withOpenApi(executeOfframpSchemaBase.shape.cryptoAmount, {
      description: "Crypto amount to sell for fiat.",
      example: "50.00",
    }),
    redirectUrl: withOpenApi(executeOfframpSchemaBase.shape.redirectUrl, {
      description: "Optional redirect URL after provider flow completes.",
    }),
    bvnkCompliance: withOpenApi(executeOfframpSchemaBase.shape.bvnkCompliance, {
      description:
        "BVNK-only compliance details. Required on BVNK off-ramp (`partyDetails` must contain at least one entry). Omit the field entirely for `moonpay` and `lightspark`.",
      example: { partyDetails: [{ type: "individual" }] },
    }),
  })
  .openapi({
    description:
      'Execute off-ramp request payload. The default example is shaped for `provider: "moonpay"`; switch `provider` to `bvnk` to attach `bvnkCompliance.partyDetails`.',
    example: {
      provider: "moonpay",
      counterpartyId: "cp_example",
      sourceWallet: "wal_example",
      cryptoToken: "USDC",
      fiatCurrency: "USD",
      cryptoAmount: "50.00",
      redirectUrl: "https://example.com",
    },
  });

export const simulateSandboxTransferRequestSchema = withOpenApi(simulateSandboxTransferSchemaBase, {
  description:
    "Sandbox-only helper to simulate provider-specific transfer completion flows. The payload is discriminated by provider.",
});

export const paymentListTransfersQuerySchema = listTransfersQuerySchemaBase
  .extend({
    wallet: withOpenApi(listTransfersQuerySchemaBase.shape.wallet, {
      description: "Filter by wallet ID.",
      example: "wal_example",
    }),
    walletAddress: withOpenApi(listTransfersQuerySchemaBase.shape.walletAddress, {
      description: "Filter by wallet address.",
      example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    }),
    token: withOpenApi(listTransfersQuerySchemaBase.shape.token, {
      description: "Filter by token symbol or mint.",
      example: "USDC",
    }),
    direction: withOpenApi(listTransfersQuerySchemaBase.shape.direction, {
      description: "Filter by transfer direction.",
      example: "outbound",
    }),
    status: withOpenApi(listTransfersQuerySchemaBase.shape.status, {
      description: "Filter by transfer status.",
      example: "confirmed",
    }),
    category: withOpenApi(listTransfersQuerySchemaBase.shape.category, {
      description: "Filter by wallet transfers or ramp transfers.",
      example: "ramp",
    }),
    counterpartyId: withOpenApi(listTransfersQuerySchemaBase.shape.counterpartyId, {
      description: "Filter transfers tied to a specific counterparty.",
      example: "counterparty_example",
    }),
    provider: withOpenApi(listTransfersQuerySchemaBase.shape.provider, {
      description:
        "Filter ramp transfers by provider. Use with providerReference to look up a quote-backed transfer exactly.",
      example: "lightspark",
    }),
    providerReference: withOpenApi(listTransfersQuerySchemaBase.shape.providerReference, {
      description:
        "Provider quote or transaction reference. Must be supplied with provider for exact ramp transfer lookup.",
      example: "Quote:019e979c-f660-5246-0000-c0588496b9ce",
    }),
    from: withOpenApi(listTransfersQuerySchemaBase.shape.from, {
      description: "Filter from timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    to: withOpenApi(listTransfersQuerySchemaBase.shape.to, {
      description: "Filter to timestamp.",
      example: "2025-01-02T00:00:00.000Z",
    }),
    page: withOpenApi(listTransfersQuerySchemaBase.shape.page, {
      description: "Page number (1-based).",
      example: 1,
    }),
    pageSize: withOpenApi(listTransfersQuerySchemaBase.shape.pageSize, {
      description: "Items per page.",
      example: 20,
    }),
  })
  .openapi({ description: "List transfers query parameters." });

export const paymentOnrampCurrenciesQuerySchema = listOnrampCurrenciesQuerySchemaBase
  .extend({
    source: withOpenApi(listOnrampCurrenciesQuerySchemaBase.shape.source, {
      description: "Optional fiat source currency filter.",
      example: "USD",
    }),
    dest: withOpenApi(listOnrampCurrenciesQuerySchemaBase.shape.dest, {
      description: "Optional Solana crypto rail destination filter.",
      example: "usdc.solana",
    }),
    provider: withOpenApi(listOnrampCurrenciesQuerySchemaBase.shape.provider, {
      description: "Optional ramp provider filter.",
      example: "moonpay",
    }),
  })
  .openapi({ description: "On-ramp currency support query parameters." });

export const paymentOfframpCurrenciesQuerySchema = listOfframpCurrenciesQuerySchemaBase
  .extend({
    source: withOpenApi(listOfframpCurrenciesQuerySchemaBase.shape.source, {
      description: "Optional Solana crypto rail source filter.",
      example: "usdc.solana",
    }),
    dest: withOpenApi(listOfframpCurrenciesQuerySchemaBase.shape.dest, {
      description: "Optional fiat destination currency filter.",
      example: "USD",
    }),
    provider: withOpenApi(listOfframpCurrenciesQuerySchemaBase.shape.provider, {
      description: "Optional ramp provider filter.",
      example: "moonpay",
    }),
  })
  .openapi({ description: "Off-ramp currency support query parameters." });

const lightsparkRampPaymentInstructionSchema = z.object({
  provider: z.literal("lightspark").openapi({
    description: "Provider that produced this instruction.",
    example: "lightspark",
  }),
  accountOrWalletInfo: z
    .object({
      accountType: z.string().openapi({ example: "USD_ACCOUNT" }),
      accountNumber: z.string().optional().openapi({ example: "0000000000000000" }),
      routingNumber: z.string().optional().openapi({ example: "000000000" }),
      paymentRails: z
        .array(z.string())
        .optional()
        .openapi({ example: ["ACH", "WIRE"] }),
      reference: z.string().optional().openapi({ example: "quote-reference-example" }),
      bankName: z.string().optional().openapi({ example: "Example Bank" }),
      address: z
        .string()
        .optional()
        .openapi({ example: "ExampleSolanaWalletAddress11111111111111111" }),
      assetType: z.string().optional().openapi({ example: "USDC" }),
    })
    .openapi({
      description: "Lightspark bank account or crypto wallet details for funding the ramp.",
    }),
  instructionsNotes: z
    .string()
    .optional()
    .openapi({ description: "Additional human-readable funding instructions." }),
  isPlatformAccount: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the payment instruction belongs to a platform account." }),
});

const bvnkRampPaymentInstructionSchema = z.object({
  provider: z.literal("bvnk").openapi({
    description: "Provider that produced this instruction.",
    example: "bvnk",
  }),
  onboardingStatus: z
    .enum(["verification_required", "verifying", "provisioning", "ready"])
    .openapi({
      description: "Where the buyer is in BVNK onboarding; 'ready' means the funding rule is live.",
      example: "ready",
    }),
  verificationUrl: z.string().optional().openapi({
    description: "Identity-verification (KYC) URL the buyer must complete before funding.",
  }),
  ruleId: z.string().optional().openapi({ description: "BVNK on-ramp payment rule id." }),
  ruleStatus: z.string().optional().openapi({ description: "Current status of the payment rule." }),
  fundingWalletId: z.string().optional().openapi({
    description: "BVNK fiat wallet the buyer funds; BVNK auto-converts arriving fiat to crypto.",
  }),
  fiatCurrency: z
    .string()
    .openapi({ description: "Fiat currency to fund the rule with.", example: "USD" }),
  beneficiaryAddress: z
    .string()
    .openapi({ description: "Destination crypto address the converted funds are sent to." }),
  network: z
    .string()
    .openapi({ description: "Destination blockchain network.", example: "SOLANA" }),
  bankAccount: z
    .object({
      accountNumber: z.string().optional(),
      code: z.string().optional(),
      accountNumberFormat: z.string().optional(),
      paymentReference: z.string().optional(),
      bankName: z.string().optional(),
    })
    .optional()
    .openapi({ description: "Bank funding details for the buyer's BVNK virtual account." }),
  instructionsNotes: z
    .string()
    .openapi({ description: "Additional human-readable funding instructions." }),
});

const rampPaymentInstructionSchema = z.discriminatedUnion("provider", [
  lightsparkRampPaymentInstructionSchema,
  bvnkRampPaymentInstructionSchema,
]);

const rampQuoteCurrencySchema = z.object({
  code: z.string().openapi({ description: "Provider currency code.", example: "USDC" }),
  decimals: z
    .number()
    .int()
    .min(0)
    .openapi({ description: "Provider decimal places for minor-unit amounts.", example: 2 }),
  name: z.string().optional().openapi({ description: "Provider currency display name." }),
  symbol: z.string().optional().openapi({ description: "Provider currency symbol." }),
});

const onrampQuoteSchema = z
  .object({
    id: z.string().openapi({ description: "Quote identifier.", example: "ramp_quote_example" }),
    provider: z.enum(RAMP_PROVIDERS).openapi({
      description: "Provider that created the quote.",
      example: "moonpay",
    }),
    status: z
      .enum(["pending", "processing", "completed", "failed"])
      .openapi({ description: "Quote status.", example: "pending" }),
    deliveryMode: z.enum(["manual_instructions", "hosted"]).openapi({
      description:
        "`hosted` means open `hostedUrl`; `manual_instructions` means display `paymentInstructions`.",
      example: "hosted",
    }),
    hostedUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Provider-hosted URL for hosted quote delivery." }),
    paymentInstructions: z.array(rampPaymentInstructionSchema).optional().openapi({
      description: "Funding instructions for `manual_instructions` delivery (e.g. BVNK on-ramp).",
    }),
    exchangeRate: z
      .number()
      .optional()
      .openapi({ description: "Units of destination crypto per unit of source fiat." }),
    totalSendingAmount: z.number().optional().openapi({
      description: "Total sending amount in fiat smallest units, including provider fees.",
    }),
    sendingCurrency: rampQuoteCurrencySchema.optional().openapi({
      description: "Currency metadata for `totalSendingAmount`.",
    }),
    totalReceivingAmount: z
      .number()
      .optional()
      .openapi({ description: "Final crypto amount received in smallest units." }),
    receivingCurrency: rampQuoteCurrencySchema.optional().openapi({
      description: "Currency metadata for `totalReceivingAmount`.",
    }),
    feesIncluded: z
      .number()
      .optional()
      .openapi({ description: "Fees included in the sending amount, in fiat smallest units." }),
    feeCurrency: rampQuoteCurrencySchema.optional().openapi({
      description: "Currency metadata for `feesIncluded`.",
    }),
    expiresAt: isoDateTimeSchema
      .optional()
      .openapi({ description: "Timestamp when the quote expires." }),
  })
  .openapi({ description: "On-ramp quote details." });

const onrampCurrencyPairSchema = z
  .object({
    source: z.string().openapi({ description: "Fiat source currency code.", example: "USD" }),
    dest: z.enum(ONRAMP_CRYPTO_RAILS).openapi({
      description: "Destination crypto rail.",
      example: "usdc.solana",
    }),
    providers: z.array(z.enum(RAMP_PROVIDERS)).openapi({
      description: "Providers that support this on-ramp pair.",
      example: ["moonpay", "lightspark"],
    }),
  })
  .openapi({ description: "Provider support for one fiat-to-crypto on-ramp pair." });

const offrampCurrencyPairSchema = z
  .object({
    source: z.enum(OFFRAMP_CRYPTO_RAILS).openapi({
      description: "Source crypto rail.",
      example: "usdc.solana",
    }),
    dest: z.string().openapi({ description: "Fiat destination currency code.", example: "USD" }),
    providers: z.array(z.enum(RAMP_PROVIDERS)).openapi({
      description: "Providers that support this off-ramp pair.",
      example: ["moonpay", "bvnk"],
    }),
  })
  .openapi({ description: "Provider support for one crypto-to-fiat off-ramp pair." });

export const onrampCurrenciesResponseSchema = z
  .object({
    currencies: z
      .object({
        sources: z.array(z.string()).openapi({
          description: "Fiat source currencies with at least one supported on-ramp pair.",
          example: ["USD", "EUR"],
        }),
        destinations: z.array(z.enum(ONRAMP_CRYPTO_RAILS)).openapi({
          description: "Crypto rails considered for Solana on-ramp support.",
          example: ["usdc.solana", "sol.solana"],
        }),
      })
      .openapi({ description: "On-ramp currency option sets." }),
    pairs: z.array(onrampCurrencyPairSchema).openapi({
      description: "Supported fiat-to-crypto pairs and their providers.",
    }),
    supportHash: z.string().openapi({
      description: "Deterministic hash of the generated ramp support matrix.",
      example: "sha256:example",
    }),
  })
  .openapi({ description: "On-ramp currency support response payload." });

export const offrampCurrenciesResponseSchema = z
  .object({
    currencies: z
      .object({
        sources: z.array(z.enum(OFFRAMP_CRYPTO_RAILS)).openapi({
          description: "Crypto rails with at least one supported off-ramp pair.",
          example: ["usdc.solana", "sol.solana"],
        }),
        destinations: z.array(z.string()).openapi({
          description: "Fiat destination currencies with at least one supported off-ramp pair.",
          example: ["USD", "EUR"],
        }),
      })
      .openapi({ description: "Off-ramp currency option sets." }),
    pairs: z.array(offrampCurrencyPairSchema).openapi({
      description: "Supported crypto-to-fiat pairs and their providers.",
    }),
    supportHash: z.string().openapi({
      description: "Deterministic hash of the generated ramp support matrix.",
      example: "sha256:example",
    }),
  })
  .openapi({ description: "Off-ramp currency support response payload." });

export const onrampExecutionSchema = z
  .object({
    id: z.string().openapi({ description: "Ramp execution identifier.", example: "ramp_example" }),
    provider: z
      .enum(RAMP_PROVIDERS)
      .openapi({ description: "Selected provider used for execution.", example: "moonpay" }),
    status: z
      .enum(["pending", "processing", "completed", "failed"])
      .openapi({ description: "Ramp execution status.", example: "pending" }),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Redirect URL for the ramp provider." }),
    paymentInstructions: z.array(rampPaymentInstructionSchema).optional().openapi({
      description: "Provider payment instructions for funding or completing the ramp.",
    }),
    reference: z
      .string()
      .optional()
      .openapi({ description: "Provider quote or transaction reference." }),
  })
  .openapi({ description: "On-ramp execution status." });

export const offrampExecutionSchema = z
  .object({
    id: z.string().openapi({ description: "Ramp execution identifier.", example: "ramp_example" }),
    provider: z
      .enum(RAMP_PROVIDERS)
      .openapi({ description: "Selected provider used for execution.", example: "moonpay" }),
    status: z
      .enum(["pending", "processing", "completed", "failed"])
      .openapi({ description: "Ramp execution status.", example: "pending" }),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Redirect URL for the ramp provider." }),
    paymentInstructions: z.array(rampPaymentInstructionSchema).optional().openapi({
      description: "Provider payment instructions for funding or completing the ramp.",
    }),
    reference: z.string().optional().openapi({ description: "Provider reference for the payout." }),
  })
  .openapi({ description: "Off-ramp execution status." });

export const walletPolicyResponseSchema = z
  .object({
    policy: walletPolicySchema.openapi({ description: "Wallet policy configuration." }),
  })
  .openapi({ description: "Wallet policy response payload." });

export const walletBalancesResponseSchema = z
  .object({
    walletBalances: walletBalancesSchema.openapi({ description: "Wallet balances details." }),
  })
  .openapi({ description: "Wallet balances response payload." });

export const transferResponseSchema = z
  .object({
    transfer: transferSchema.openapi({ description: "Transfer details." }),
    privateTransfer: preparedPrivateTransferSchema
      .optional()
      .openapi({ description: "Provider metadata returned for private-transfer execution." }),
  })
  .openapi({ description: "Transfer response payload." });

export const onrampExecutionResponseSchema = z
  .object({
    ramp: onrampExecutionSchema.openapi({ description: "On-ramp execution details." }),
  })
  .openapi({ description: "On-ramp execution response payload." });

export const onrampQuoteResponseSchema = z
  .object({
    quote: onrampQuoteSchema.openapi({ description: "On-ramp quote details." }),
  })
  .openapi({ description: "On-ramp quote response payload." });

export const offrampExecutionResponseSchema = z
  .object({
    ramp: offrampExecutionSchema.openapi({ description: "Off-ramp execution details." }),
  })
  .openapi({ description: "Off-ramp execution response payload." });

export const sandboxTransferSimulationResponseSchema = z
  .object({
    transaction: z
      .record(z.string(), z.unknown())
      .openapi({ description: "Provider sandbox transaction response." }),
  })
  .openapi({ description: "Sandbox transfer simulation response payload." });
