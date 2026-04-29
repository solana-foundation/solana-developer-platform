import {
  base64Schema,
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  solanaAddressSchema,
  transferIdParamSchema,
  walletIdParamSchema,
  z,
} from "./base";
import { preparedTransactionSchema, simulationResultSchema } from "./issuance";

export const tokenAmountSchema = z.string().openapi({
  description: "Token amount in UI units (decimal string).",
  example: "100.00",
});

export const walletTypeSchema = z
  .enum(["treasury", "operations", "user"])
  .openapi({ description: "Wallet type.", example: "treasury" });

export const custodyProviderSchema = z
  .enum(["turnkey", "privy", "aws-kms", "fireblocks", "vault"])
  .openapi({ description: "Custody provider.", example: "fireblocks" });

export const custodyConfigSchema = z
  .object({
    provider: custodyProviderSchema,
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: "Provider-specific configuration payload." }),
  })
  .openapi({ description: "Custody configuration." });

export const createWalletRequestSchema = z
  .object({
    name: z.string().max(64).openapi({ description: "Wallet name.", example: "Ops Wallet" }),
    type: walletTypeSchema,
    custody: custodyConfigSchema,
  })
  .openapi({ description: "Create wallet request payload." });

export const walletSchema = z
  .object({
    id: walletIdParamSchema,
    address: solanaAddressSchema.openapi({
      description: "Wallet address.",
      example: "So11111111111111111111111111111111111111112",
    }),
    name: z.string().openapi({ description: "Wallet name.", example: "Treasury Wallet" }),
    type: walletTypeSchema,
    custody: z
      .object({
        provider: custodyProviderSchema,
      })
      .openapi({ description: "Custody provider metadata." }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Timestamp when the wallet was created.",
      example: "2025-01-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Managed wallet." });

export const walletPolicySchema = z
  .object({
    walletId: walletIdParamSchema.openapi({
      description: "Custody wallet ID from /v1/wallets.",
      example: "wal_example",
    }),
    destinationAllowlist: z.array(solanaAddressSchema).openapi({
      description:
        "Allowed destination addresses. An empty array means no destination restrictions.",
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

export const updateWalletPolicyRequestSchema = z
  .object({
    destinationAllowlist: z.array(solanaAddressSchema).openapi({
      description:
        "Allowed destination addresses. An empty array means no destination restrictions.",
    }),
    maxTransferAmount: tokenAmountSchema
      .optional()
      .openapi({ description: "Maximum amount allowed per transfer." }),
    maxDailyAmount: tokenAmountSchema
      .optional()
      .openapi({ description: "Maximum total amount allowed per day." }),
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

export const createTransferRequestSchema = z
  .object({
    projectId: projectIdParamSchema
      .optional()
      .openapi({ description: "Project identifier for the transfer context." }),
    source: z.string().openapi({
      description: "Source custody wallet ID from /v1/wallets.",
      example: "wal_example",
    }),
    destination: solanaAddressSchema.openapi({ description: "Destination wallet address." }),
    token: z.string().openapi({ description: "Token symbol or mint address." }),
    amount: tokenAmountSchema,
    memo: z
      .string()
      .max(256)
      .optional()
      .openapi({ description: "Optional memo for the transfer." }),
  })
  .openapi({
    description:
      "Create transfer request payload for a custody-managed source wallet. This endpoint does not provision wallets.",
  });

export const priorityFeeSchema = z
  .enum(["none", "low", "medium", "high", "auto"])
  .openapi({ description: "Priority fee level.", example: "auto" });

export const prepareTransferRequestSchema = z
  .object({
    projectId: projectIdParamSchema
      .optional()
      .openapi({ description: "Project identifier for the transfer context." }),
    source: z.string().openapi({
      description: "Source custody wallet ID from /v1/wallets.",
      example: "wal_example",
    }),
    destination: solanaAddressSchema.openapi({ description: "Destination wallet address." }),
    token: z.string().openapi({ description: "Token symbol or mint address." }),
    amount: tokenAmountSchema,
    memo: z
      .string()
      .max(256)
      .optional()
      .openapi({ description: "Optional memo for the transfer." }),
    referenceAddress: solanaAddressSchema.optional().openapi({
      description: "Optional reference address for tracking (Solana Pay reference account).",
    }),
    options: z
      .object({
        priorityFee: priorityFeeSchema
          .optional()
          .openapi({ description: "Priority fee level (default: auto)." }),
        simulate: z.boolean().optional().openapi({
          description: "Include simulation results in the response.",
          example: true,
        }),
      })
      .optional()
      .openapi({ description: "Transaction preparation options." }),
  })
  .openapi({
    description:
      "Prepare transfer request payload for a custody-managed source wallet. Wallet provisioning is handled by /v1/wallets.",
  });

export const transferTypeSchema = z
  .enum(["transfer", "transfer_confidential"])
  .openapi({ description: "Transfer type.", example: "transfer" });

export const transferDirectionSchema = z
  .enum(["inbound", "outbound"])
  .openapi({ description: "Transfer direction.", example: "outbound" });

export const transferStatusSchema = z
  .enum(["pending", "processing", "confirmed", "finalized", "failed"])
  .openapi({ description: "Transfer status.", example: "confirmed" });

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

export const createConfidentialTransferRequestSchema = z
  .object({
    source: z.string().openapi({ description: "Source wallet ID." }),
    destination: z.string().openapi({ description: "Destination wallet ID." }),
    token: z.string().openapi({ description: "Token symbol or mint address." }),
    amount: tokenAmountSchema,
  })
  .openapi({ description: "Create confidential transfer request payload." });

export const feeQuoteSchema = z
  .object({
    feeToken: z.string().openapi({ description: "Fee token symbol.", example: "USDC" }),
    feeAmount: tokenAmountSchema,
  })
  .openapi({ description: "Fee quote details." });

const moonpayCurrencyCodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]+$/)
  .openapi({
    description:
      "Crypto token symbol or provider currency code. Simple symbols like `USDC` and `SOL` are normalized server-side for supported providers.",
    example: "USDC",
  });

const rampProviderSchema = z.enum(["moonpay", "lightspark", "bvnk"]).openapi({
  description:
    "Ramp provider identifier. Explicit provider selection is required because each provider has different flow requirements.",
  example: "moonpay",
});

const bvnkComplianceSchema = z
  .object({
    partyDetails: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .openapi({ description: "BVNK party details payload. Required for BVNK off-ramp flows." }),
  })
  .openapi({ description: "Optional BVNK compliance details." });

export const executeOnrampRequestSchema = z
  .object({
    provider: rampProviderSchema,
    destinationWallet: z.string().openapi({
      description: "Destination wallet ID or Solana address for purchased crypto.",
    }),
    cryptoToken: moonpayCurrencyCodeSchema,
    fiatCurrency: z.literal("USD").optional().openapi({
      description: "Fiat currency for on-ramp. USD only.",
      example: "USD",
    }),
    fiatAmount: tokenAmountSchema.openapi({
      description:
        "Fiat amount in USD to purchase crypto with. MoonPay on-ramp requires at least 20 USD.",
      example: "100.00",
    }),
    kycReference: z
      .string()
      .optional()
      .openapi({ description: "Optional KYC reference identifier." }),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Optional redirect URL after provider flow completes." }),
    bvnkCompliance: bvnkComplianceSchema.optional(),
  })
  .openapi({
    description:
      "Execute on-ramp request payload. Note: BVNK on-ramp requires additional provider-side account enablement and compliance setup beyond API credentials.",
  });

export const executeOfframpRequestSchema = z
  .object({
    provider: rampProviderSchema,
    sourceWallet: z.string().openapi({
      description: "Source wallet ID or Solana address for crypto-to-fiat off-ramp.",
    }),
    cryptoToken: moonpayCurrencyCodeSchema,
    fiatCurrency: z.literal("USD").optional().openapi({
      description: "Fiat payout currency. USD only.",
      example: "USD",
    }),
    cryptoAmount: tokenAmountSchema.openapi({
      description: "Crypto amount to sell for fiat.",
      example: "50.00",
    }),
    kycReference: z
      .string()
      .optional()
      .openapi({ description: "Optional KYC reference identifier." }),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Optional redirect URL after provider flow completes." }),
    bvnkCompliance: bvnkComplianceSchema.optional(),
  })
  .openapi({ description: "Execute off-ramp request payload." });

export const onrampExecutionSchema = z
  .object({
    id: z.string().openapi({ description: "Ramp execution identifier.", example: "ramp_example" }),
    provider: z
      .string()
      .openapi({ description: "Selected provider used for execution.", example: "moonpay" }),
    status: z
      .enum(["pending", "processing", "completed", "failed"])
      .openapi({ description: "Ramp execution status.", example: "pending" }),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Redirect URL for the ramp provider." }),
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
      .string()
      .openapi({ description: "Selected provider used for execution.", example: "moonpay" }),
    status: z
      .enum(["pending", "processing", "completed", "failed"])
      .openapi({ description: "Ramp execution status.", example: "pending" }),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Redirect URL for the ramp provider." }),
    reference: z.string().optional().openapi({ description: "Provider reference for the payout." }),
  })
  .openapi({ description: "Off-ramp execution status." });

export const walletResponseSchema = z
  .object({
    wallet: walletSchema.openapi({ description: "Wallet details." }),
  })
  .openapi({ description: "Wallet response payload." });

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

export const feeQuoteResponseSchema = z
  .object({
    feeQuote: feeQuoteSchema.openapi({ description: "Fee quote details." }),
  })
  .openapi({ description: "Fee quote response payload." });

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
