import { OFFRAMP_CRYPTO_RAILS, ONRAMP_CRYPTO_RAILS, RAMP_PROVIDERS } from "@sdp/types";
import {
  createOnrampQuoteSchema as createOnrampQuoteSchemaBase,
  createTransferSchema as createTransferSchemaBase,
  executeOfframpSchema as executeOfframpSchemaBase,
  executeOnrampSchema as executeOnrampSchemaBase,
  listOfframpCurrenciesQuerySchema as listOfframpCurrenciesQuerySchemaBase,
  listOnrampCurrenciesQuerySchema as listOnrampCurrenciesQuerySchemaBase,
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
      description: "Fiat currency for on-ramp.",
      example: "USD",
    }),
    fiatAmount: withOpenApi(executeOnrampSchemaBase.shape.fiatAmount, {
      description:
        "Fiat amount to purchase crypto with. MoonPay on-ramp requires at least 20 units of the selected fiat currency.",
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

const rampPaymentInstructionSchema = z.discriminatedUnion("provider", [
  lightsparkRampPaymentInstructionSchema,
]);

const onrampQuoteSchema = z
  .object({
    id: z.string().openapi({ description: "Quote identifier.", example: "ramp_quote_example" }),
    provider: z.enum(["moonpay", "lightspark"]).openapi({
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
    exchangeRate: z
      .number()
      .optional()
      .openapi({ description: "Units of destination crypto per unit of source fiat." }),
    totalSendingAmount: z.number().optional().openapi({
      description: "Total sending amount in fiat smallest units, including provider fees.",
    }),
    totalReceivingAmount: z
      .number()
      .optional()
      .openapi({ description: "Final crypto amount received in smallest units." }),
    feesIncluded: z
      .number()
      .optional()
      .openapi({ description: "Fees included in the sending amount, in fiat smallest units." }),
    expiresAt: isoDateTimeSchema
      .optional()
      .openapi({ description: "Timestamp when the quote expires." }),
    paymentInstructions: z.array(rampPaymentInstructionSchema).optional().openapi({
      description: "Manual funding instructions for instruction-based quote delivery.",
    }),
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
