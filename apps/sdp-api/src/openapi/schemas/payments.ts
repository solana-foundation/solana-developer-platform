import { RAMP_PROVIDERS } from "@sdp/types";
import {
  createTransferSchema as createTransferSchemaBase,
  executeOfframpSchema as executeOfframpSchemaBase,
  executeOnrampSchema as executeOnrampSchemaBase,
  listTransfersQuerySchema as listTransfersQuerySchemaBase,
  prepareTransferOptionsSchema as prepareTransferOptionsSchemaBase,
  prepareTransferSchema as prepareTransferSchemaBase,
  priorityFeeSchema as priorityFeeSchemaBase,
  simulateSandboxTransferSchema as simulateSandboxTransferSchemaBase,
  transferDirectionSchema as transferDirectionSchemaBase,
  transferIdParamsSchema as transferIdParamsSchemaBase,
  transferStatusSchema as transferStatusSchemaBase,
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
      description: "Transaction preparation options.",
      example: { priorityFee: "auto", simulate: true },
    }),
  })
  .openapi({
    description:
      "Prepare transfer request payload for a custody-managed source wallet. Wallet provisioning is handled by /v1/wallets.",
  });

export const transferTypeSchema = z
  .enum(["transfer", "transfer_confidential"])
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

export const prepareTransferResponseSchema = z
  .object({
    transfer: transferSchema.openapi({ description: "Transfer transaction record." }),
    preparedTransaction: preparedTransactionSchema.openapi({
      description: "Prepared transaction for client-side signing.",
    }),
    simulation: simulationResultSchema
      .optional()
      .openapi({ description: "Optional transaction simulation result." }),
  })
  .openapi({ description: "Prepare transfer response payload." });

export const executeOnrampRequestSchema = executeOnrampSchemaBase
  .extend({
    provider: withOpenApi(executeOnrampSchemaBase.shape.provider, {
      description:
        "Ramp provider identifier. Explicit provider selection is required because each provider has different flow requirements.",
      example: "moonpay",
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
      description: "Fiat currency for on-ramp. USD only.",
      example: "USD",
    }),
    fiatAmount: withOpenApi(executeOnrampSchemaBase.shape.fiatAmount, {
      description:
        "Fiat amount in USD to purchase crypto with. MoonPay on-ramp requires at least 20 USD.",
      example: "100.00",
    }),
    kycReference: withOpenApi(executeOnrampSchemaBase.shape.kycReference, {
      description: "Optional KYC reference identifier.",
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
      destinationWallet: "wal_example",
      cryptoToken: "USDC",
      fiatCurrency: "USD",
      fiatAmount: "100.00",
      kycReference: "",
      redirectUrl: "https://example.com",
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
      description: "Fiat payout currency. USD only.",
      example: "USD",
    }),
    cryptoAmount: withOpenApi(executeOfframpSchemaBase.shape.cryptoAmount, {
      description: "Crypto amount to sell for fiat.",
      example: "50.00",
    }),
    kycReference: withOpenApi(executeOfframpSchemaBase.shape.kycReference, {
      description: "Optional KYC reference identifier.",
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
      sourceWallet: "wal_example",
      cryptoToken: "USDC",
      fiatCurrency: "USD",
      cryptoAmount: "50.00",
      kycReference: "",
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

const rampPaymentInstructionSchema = z.discriminatedUnion("provider", [
  lightsparkRampPaymentInstructionSchema,
]);

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
  })
  .openapi({ description: "Transfer response payload." });

export const onrampExecutionResponseSchema = z
  .object({
    ramp: onrampExecutionSchema.openapi({ description: "On-ramp execution details." }),
  })
  .openapi({ description: "On-ramp execution response payload." });

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
