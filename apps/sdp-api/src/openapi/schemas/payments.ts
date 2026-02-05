import { z } from "./base";
import {
  apiKeyIdParamSchema,
  base64Schema,
  isoDateTimeSchema,
  orgIdParamSchema,
  paymentRequestIdParamSchema,
  solanaAddressSchema,
  transferIdParamSchema,
  walletIdParamSchema,
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
      .record(z.unknown())
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

export const walletPolicyModeSchema = z.enum(["none", "allowlist"]).openapi({
  description: "Policy mode for outbound destinations.",
  example: "allowlist",
});

export const walletPolicySchema = z
  .object({
    walletId: walletIdParamSchema,
    mode: walletPolicyModeSchema,
    destinationAllowlist: z
      .array(solanaAddressSchema)
      .openapi({ description: "Allowed destination addresses when allowlist mode is enabled." }),
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
  .openapi({ description: "Wallet policy configuration." });

export const updateWalletPolicyRequestSchema = z
  .object({
    mode: walletPolicyModeSchema,
    destinationAllowlist: z
      .array(solanaAddressSchema)
      .openapi({ description: "Allowed destination addresses when allowlist mode is enabled." }),
    maxTransferAmount: tokenAmountSchema
      .optional()
      .openapi({ description: "Maximum amount allowed per transfer." }),
    maxDailyAmount: tokenAmountSchema
      .optional()
      .openapi({ description: "Maximum total amount allowed per day." }),
  })
  .openapi({ description: "Update wallet policy request payload." });

export const tokenBalanceSchema = z
  .object({
    token: z.string().openapi({ description: "Token symbol.", example: "USDC" }),
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
    confidential: z
      .boolean()
      .openapi({ description: "Confidential balance flag.", example: false }),
  })
  .openapi({ description: "Token balance details." });

export const walletBalancesSchema = z
  .object({
    walletId: walletIdParamSchema,
    address: solanaAddressSchema.openapi({ description: "Wallet address." }),
    balances: z.array(tokenBalanceSchema).openapi({ description: "Token balances." }),
  })
  .openapi({ description: "Wallet balances payload." });

export const gaslessConfigSchema = z
  .object({
    enabled: z.boolean().openapi({ description: "Enable gasless fees.", example: true }),
    feeToken: z
      .string()
      .optional()
      .openapi({ description: "Token symbol used to pay fees.", example: "USDC" }),
  })
  .openapi({ description: "Gasless fee payment configuration." });

export const createTransferRequestSchema = z
  .object({
    source: z.string().openapi({ description: "Source wallet ID." }),
    destination: solanaAddressSchema.openapi({ description: "Destination wallet address." }),
    token: z
      .string()
      .optional()
      .openapi({ description: "Token symbol or mint address (omit for SOL)." }),
    amount: tokenAmountSchema,
    gasless: gaslessConfigSchema.optional(),
    memo: z
      .string()
      .max(256)
      .optional()
      .openapi({ description: "Optional memo for the transfer." }),
  })
  .openapi({ description: "Create transfer request payload." });

export const priorityFeeSchema = z
  .enum(["none", "low", "medium", "high", "auto"])
  .openapi({ description: "Priority fee level.", example: "auto" });

export const prepareTransferRequestSchema = z
  .object({
    source: z.string().openapi({ description: "Source wallet ID or pubkey." }),
    destination: solanaAddressSchema.openapi({ description: "Destination wallet address." }),
    token: z
      .string()
      .optional()
      .openapi({ description: "Token symbol or mint address (omit for SOL)." }),
    amount: tokenAmountSchema,
    memo: z
      .string()
      .max(256)
      .optional()
      .openapi({ description: "Optional memo for the transfer." }),
    reference: solanaAddressSchema
      .optional()
      .openapi({ description: "Optional reference key for tracking." }),
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
  .openapi({ description: "Prepare transfer request payload." });

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

export const transferSchema = z
  .object({
    id: transferIdParamSchema,
    organizationId: orgIdParamSchema,
    type: transferTypeSchema,
    direction: transferDirectionSchema,
    status: transferStatusSchema,
    signature: z
      .string()
      .nullable()
      .openapi({ description: "Solana transaction signature.", example: "sig_example" }),
    serializedTx: base64Schema.nullable().openapi({
      description: "Base64-encoded transaction payload, if available.",
      example: "AQID",
    }),
    params: z
      .record(z.unknown())
      .openapi({ description: "Operation parameters captured for audit." }),
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
    initiatedByKeyId: apiKeyIdParamSchema
      .nullable()
      .openapi({ description: "API key that initiated the transfer." }),
    source: solanaAddressSchema.optional().openapi({ description: "Source wallet address." }),
    destination: solanaAddressSchema
      .optional()
      .openapi({ description: "Destination wallet address." }),
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

export const createPaymentRequestRequestSchema = z
  .object({
    recipient: z.string().openapi({ description: "Recipient wallet ID." }),
    amount: tokenAmountSchema,
    token: z.string().openapi({ description: "Token symbol or mint address." }),
    label: z.string().max(64).optional().openapi({ description: "Merchant/recipient name." }),
    message: z
      .string()
      .max(256)
      .optional()
      .openapi({ description: "Payment request description." }),
    expiresIn: z
      .number()
      .int()
      .min(60)
      .max(86400)
      .optional()
      .openapi({ description: "Expiration time in seconds.", example: 3600 }),
  })
  .openapi({ description: "Create payment request payload." });

export const paymentRequestStatusSchema = z
  .enum(["pending", "fulfilled", "expired", "cancelled"])
  .openapi({ description: "Payment request status.", example: "pending" });

export const paymentRequestSchema = z
  .object({
    id: paymentRequestIdParamSchema,
    reference: solanaAddressSchema.openapi({ description: "Solana Pay reference address." }),
    solanaPayUrl: z
      .string()
      .url()
      .openapi({ description: "Solana Pay URL.", example: "solana:example" }),
    qrCode: z.string().openapi({
      description: "Base64-encoded QR code SVG.",
      example: "PHN2ZyB4bWxucz0iLi4uIi8+",
    }),
    status: paymentRequestStatusSchema,
    expiresAt: isoDateTimeSchema.openapi({
      description: "Expiration timestamp for the request.",
      example: "2025-01-01T01:00:00.000Z",
    }),
  })
  .openapi({ description: "Payment request details." });

export const feeQuoteSchema = z
  .object({
    feeToken: z.string().openapi({ description: "Fee token symbol.", example: "USDC" }),
    feeAmount: tokenAmountSchema,
  })
  .openapi({ description: "Fee quote details." });

export const rampProviderSchema = z
  .enum(["bridge", "moonpay", "ramp", "transak"])
  .openapi({ description: "Ramp provider.", example: "moonpay" });

export const onrampQuoteRequestSchema = z
  .object({
    fiatCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .openapi({ description: "Fiat currency code (ISO 4217).", example: "USD" }),
    fiatAmount: tokenAmountSchema,
    cryptoToken: z.string().openapi({ description: "Crypto token symbol.", example: "USDC" }),
    provider: rampProviderSchema.optional(),
  })
  .openapi({ description: "On-ramp quote request payload." });

export const offrampQuoteRequestSchema = z
  .object({
    fiatCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .openapi({ description: "Fiat currency code (ISO 4217).", example: "USD" }),
    cryptoToken: z.string().openapi({ description: "Crypto token symbol.", example: "USDC" }),
    cryptoAmount: tokenAmountSchema.openapi({
      description: "Amount of crypto to off-ramp.",
      example: "250.00",
    }),
    provider: rampProviderSchema.optional(),
  })
  .openapi({ description: "Off-ramp quote request payload." });

export const onrampQuoteSchema = z
  .object({
    id: z.string().openapi({ description: "Ramp quote identifier.", example: "quote_example" }),
    fiatCurrency: z.string().openapi({ description: "Fiat currency code.", example: "USD" }),
    fiatAmount: tokenAmountSchema,
    cryptoToken: z.string().openapi({ description: "Crypto token symbol.", example: "USDC" }),
    cryptoAmount: tokenAmountSchema,
    exchangeRate: tokenAmountSchema.optional().openapi({ description: "Exchange rate." }),
    fees: z
      .object({
        network: tokenAmountSchema.optional().openapi({ description: "Network fee." }),
        provider: tokenAmountSchema.optional().openapi({ description: "Provider fee." }),
      })
      .optional()
      .openapi({ description: "Fee breakdown." }),
    expiresAt: isoDateTimeSchema.openapi({ description: "Quote expiration." }),
  })
  .openapi({ description: "On-ramp quote details." });

export const offrampQuoteSchema = z
  .object({
    id: z.string().openapi({ description: "Ramp quote identifier.", example: "quote_example" }),
    fiatCurrency: z.string().openapi({ description: "Fiat currency code.", example: "USD" }),
    fiatAmount: tokenAmountSchema.openapi({
      description: "Fiat payout amount.",
      example: "250.00",
    }),
    cryptoToken: z.string().openapi({ description: "Crypto token symbol.", example: "USDC" }),
    cryptoAmount: tokenAmountSchema,
    exchangeRate: tokenAmountSchema.optional().openapi({ description: "Exchange rate." }),
    fees: z
      .object({
        network: tokenAmountSchema.optional().openapi({ description: "Network fee." }),
        provider: tokenAmountSchema.optional().openapi({ description: "Provider fee." }),
      })
      .optional()
      .openapi({ description: "Fee breakdown." }),
    expiresAt: isoDateTimeSchema.openapi({ description: "Quote expiration." }),
  })
  .openapi({ description: "Off-ramp quote details." });

export const executeOnrampRequestSchema = z
  .object({
    quoteId: z.string().openapi({ description: "Ramp quote identifier." }),
    destinationWallet: z.string().openapi({ description: "Wallet ID for delivery/debit." }),
    kycReference: z
      .string()
      .optional()
      .openapi({ description: "Optional KYC reference identifier." }),
  })
  .openapi({ description: "Execute on-ramp request payload." });

export const executeOfframpRequestSchema = z
  .object({
    quoteId: z.string().openapi({ description: "Ramp quote identifier." }),
    sourceWallet: z.string().openapi({ description: "Wallet ID for debit." }),
    kycReference: z
      .string()
      .optional()
      .openapi({ description: "Optional KYC reference identifier." }),
  })
  .openapi({ description: "Execute off-ramp request payload." });

export const onrampExecutionSchema = z
  .object({
    id: z.string().openapi({ description: "Ramp execution identifier.", example: "ramp_example" }),
    status: z
      .enum(["pending", "processing", "completed", "failed"])
      .openapi({ description: "Ramp execution status.", example: "pending" }),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: "Redirect URL for the ramp provider." }),
  })
  .openapi({ description: "On-ramp execution status." });

export const offrampExecutionSchema = z
  .object({
    id: z.string().openapi({ description: "Ramp execution identifier.", example: "ramp_example" }),
    status: z
      .enum(["pending", "processing", "completed", "failed"])
      .openapi({ description: "Ramp execution status.", example: "pending" }),
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

export const paymentRequestResponseSchema = z
  .object({
    paymentRequest: paymentRequestSchema.openapi({ description: "Payment request details." }),
  })
  .openapi({ description: "Payment request response payload." });

export const feeQuoteResponseSchema = z
  .object({
    feeQuote: feeQuoteSchema.openapi({ description: "Fee quote details." }),
  })
  .openapi({ description: "Fee quote response payload." });

export const onrampQuoteResponseSchema = z
  .object({
    rampQuote: onrampQuoteSchema.openapi({ description: "On-ramp quote details." }),
  })
  .openapi({ description: "On-ramp quote response payload." });

export const offrampQuoteResponseSchema = z
  .object({
    rampQuote: offrampQuoteSchema.openapi({ description: "Off-ramp quote details." }),
  })
  .openapi({ description: "Off-ramp quote response payload." });

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
