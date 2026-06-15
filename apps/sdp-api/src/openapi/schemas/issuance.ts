import { TOKEN_TRANSACTION_STATUSES, TOKEN_TRANSACTION_TYPES } from "@sdp/types";

import {
  addAllowlistSchema as addTokenAllowlistSchemaBase,
  burnSchema as burnSchemaBase,
  createTokenSchema as createTokenSchemaBase,
  forceBurnSchema as forceBurnSchemaBase,
  freezeSchema as freezeSchemaBase,
  mintSchema as mintSchemaBase,
  pauseTokenSchema as pauseTokenSchemaBase,
  seizeSchema as seizeSchemaBase,
  unfreezeSchema as unfreezeSchemaBase,
  updateAuthoritySchema as updateAuthoritySchemaBase,
  updateTokenSchema as updateTokenSchemaBase,
} from "../../routes/issuance/schemas";
import {
  apiKeyIdParamSchema,
  base64Schema,
  frozenAccountIdSchema,
  isoDateTimeSchema,
  orgIdParamSchema,
  projectIdParamSchema,
  solanaAddressSchema,
  tokenAllowlistEntryIdSchema,
  tokenIdParamSchema,
  tokenTransactionIdSchema,
  walletIdParamSchema,
  withOpenApi,
  z,
} from "./base";

export const ISSUANCE_TOKEN_AMOUNT_DESCRIPTION =
  'Token amount in UI units (decimal string). Human-readable value such as "1" or "1.5". SDP converts to on-chain base units using the token\'s decimals field.';

export const tokenExtensionsConfigSchema = z
  .object({
    transferFee: z
      .object({
        basisPoints: z.number().int().min(0).max(10000).openapi({
          description: "Transfer fee in basis points (0-10000).",
          example: 25,
        }),
        maxFee: z.string().openapi({
          description: "Maximum fee in UI units.",
          example: "0.5",
        }),
        transferFeeConfigAuthority: solanaAddressSchema.openapi({
          description: "Authority to configure transfer fees.",
          example: "So11111111111111111111111111111111111111112",
        }),
        withdrawWithheldAuthority: solanaAddressSchema.openapi({
          description: "Authority to withdraw withheld fees.",
          example: "So11111111111111111111111111111111111111112",
        }),
      })
      .optional()
      .openapi({ description: "Transfer fee configuration." }),
    interestBearing: z
      .object({
        rate: z.number().openapi({
          description: "Interest rate in percent.",
          example: 2.5,
        }),
        rateAuthority: solanaAddressSchema.openapi({
          description: "Authority that can update the rate.",
          example: "So11111111111111111111111111111111111111112",
        }),
      })
      .optional()
      .openapi({ description: "Interest-bearing configuration." }),
    permanentDelegate: solanaAddressSchema.optional().openapi({
      description: "Permanent delegate address.",
      example: "So11111111111111111111111111111111111111112",
    }),
    pausable: z
      .object({
        authority: solanaAddressSchema.optional().openapi({
          description: "Authority that can pause/resume transfers.",
          example: "So11111111111111111111111111111111111111112",
        }),
      })
      .optional()
      .openapi({ description: "Pausable configuration." }),
    nonTransferable: z
      .boolean()
      .optional()
      .openapi({ description: "Mark token as non-transferable.", example: false }),
    defaultAccountState: z
      .enum(["initialized", "frozen"])
      .optional()
      .openapi({ description: "Default account state.", example: "initialized" }),
    scaledUiAmount: z
      .object({
        authority: solanaAddressSchema.optional().openapi({
          description: "Authority that can update scaled UI parameters.",
          example: "So11111111111111111111111111111111111111112",
        }),
        multiplier: z.number().openapi({
          description: "Current UI multiplier.",
          example: 1,
        }),
        newMultiplier: z.number().openapi({
          description: "Scheduled multiplier.",
          example: 2,
        }),
        newMultiplierEffectiveTimestamp: z.number().int().openapi({
          description: "Unix timestamp (seconds) when the new multiplier takes effect.",
          example: 1735689600,
        }),
      })
      .optional()
      .openapi({ description: "Scaled UI amount configuration." }),
    transferHook: z
      .object({
        programId: solanaAddressSchema.openapi({
          description: "Transfer hook program id.",
          example: "So11111111111111111111111111111111111111112",
        }),
        authority: solanaAddressSchema.optional().openapi({
          description: "Authority that can update the transfer hook program.",
          example: "So11111111111111111111111111111111111111112",
        }),
      })
      .optional()
      .openapi({ description: "Transfer hook configuration." }),
  })
  .strict()
  .openapi({ description: "Token-2022 extensions configuration." });

export const tokenTemplateIdSchema = z
  .enum(["stablecoin", "arcade", "tokenized-security", "custom", "rwa"])
  .openapi({
    description: "Token template identifier.",
    example: "stablecoin",
  });

export const tokenSchema = z
  .object({
    id: tokenIdParamSchema,
    projectId: projectIdParamSchema,
    organizationId: orgIdParamSchema,
    signingWalletId: walletIdParamSchema.nullable().openapi({
      description: "Preferred custody wallet ID used for token deploy/admin/write actions.",
      example: "wal_example",
    }),
    mintAddress: solanaAddressSchema.nullable().openapi({
      description: "Mint address once deployed.",
      example: "So11111111111111111111111111111111111111112",
    }),
    mintAuthority: solanaAddressSchema.nullable().openapi({
      description: "Mint authority address, if set.",
      example: "So11111111111111111111111111111111111111112",
    }),
    freezeAuthority: solanaAddressSchema.nullable().openapi({
      description: "Freeze authority address, if set.",
      example: "So11111111111111111111111111111111111111112",
    }),
    ablListAddress: solanaAddressSchema.nullable().openapi({
      description: "On-chain allowlist/blocklist address, if enabled.",
      example: "So11111111111111111111111111111111111111112",
    }),
    name: z.string().openapi({ description: "Token name.", example: "Example Token" }),
    symbol: z.string().openapi({ description: "Token symbol.", example: "EXM" }),
    decimals: z.number().int().openapi({ description: "Token decimals.", example: 9 }),
    description: z
      .string()
      .nullable()
      .openapi({ description: "Token description.", example: "Example token description." }),
    uri: z.string().nullable().openapi({
      description: "Metadata URI passed to on-chain token metadata (points to off-chain JSON).",
      example: "https://example.com/metadata.json",
    }),
    imageUrl: z
      .string()
      .nullable()
      .openapi({ description: "Token image URL.", example: "https://example.com/token.png" }),
    template: tokenTemplateIdSchema.openapi({
      description: "Token template identifier.",
      example: "stablecoin",
    }),
    extensions: tokenExtensionsConfigSchema
      .nullable()
      .openapi({ description: "Token-2022 extensions configuration." }),
    totalSupply: z.string().openapi({
      description:
        "Cached total supply in UI units (stored to avoid frequent RPC reads). Use POST /v1/issuance/tokens/{tokenId}/supply/refresh to force an on-chain refresh.",
      example: "1000000",
    }),
    totalSupplyUpdatedAt: isoDateTimeSchema
      .nullable()
      .openapi({ description: "Timestamp when supply was last refreshed.", example: null }),
    maxSupply: z
      .string()
      .nullable()
      .openapi({ description: "Maximum supply in UI units, if capped.", example: "10000000" }),
    isMintable: z
      .boolean()
      .openapi({ description: "Whether additional minting is allowed.", example: true }),
    isFreezable: z
      .boolean()
      .openapi({ description: "Whether freeze authority is enabled.", example: true }),
    requiresAllowlist: z
      .boolean()
      .openapi({ description: "Whether transfers require allowlist approval.", example: false }),
    status: z
      .enum(["pending", "active", "paused", "revoked"])
      .openapi({ description: "Token lifecycle status.", example: "active" }),
    deployedAt: isoDateTimeSchema.nullable().openapi({
      description: "Deployment timestamp, if deployed.",
      example: "2025-01-05T00:00:00.000Z",
    }),
    createdBy: z.string().openapi({
      description: "Actor identifier that created the token.",
      example: "key_example",
    }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    updatedAt: isoDateTimeSchema.openapi({
      description: "Last update timestamp.",
      example: "2025-01-02T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Token record." });

export const tokenTransactionSchema = z
  .object({
    id: tokenTransactionIdSchema,
    tokenId: tokenIdParamSchema,
    organizationId: orgIdParamSchema,
    type: z
      .enum(TOKEN_TRANSACTION_TYPES)
      .openapi({ description: "Transaction type.", example: "mint" }),
    status: z
      .enum(TOKEN_TRANSACTION_STATUSES)
      .openapi({ description: "Transaction status.", example: "confirmed" }),
    signature: z
      .string()
      .nullable()
      .openapi({ description: "Solana transaction signature.", example: "sig_example" }),
    idempotencyKey: z.string().optional().openapi({
      description: "Idempotency key used for this request.",
      example: "idem_example_12345",
    }),
    idempotencyFingerprint: z.string().optional().openapi({
      description: "Request fingerprint used to validate idempotent retries.",
      example: "4f2d9c7a5e6f1c...",
    }),
    serializedTx: base64Schema.nullable().openapi({
      description: "Base64-encoded transaction payload, if available.",
      example: "AQID",
    }),
    params: z
      .record(z.string(), z.unknown())
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
      .openapi({ description: "API key that initiated the transaction." }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    updatedAt: isoDateTimeSchema.openapi({
      description: "Last update timestamp.",
      example: "2025-01-02T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Token transaction record." });

export const tokenTransactionListItemSchema = z
  .object({
    token: z
      .object({
        id: tokenIdParamSchema,
        name: z.string().openapi({ description: "Token name.", example: "Example Token" }),
        symbol: z.string().openapi({ description: "Token symbol.", example: "EXM" }),
        mintAddress: solanaAddressSchema
          .nullable()
          .openapi({ description: "Mint address once deployed.", example: null }),
      })
      .openapi({ description: "Token metadata for this transaction." }),
    transaction: tokenTransactionSchema.openapi({ description: "Token transaction record." }),
  })
  .openapi({ description: "Cross-token transaction list item." });

export const tokenAllowlistEntrySchema = z
  .object({
    id: tokenAllowlistEntryIdSchema,
    tokenId: tokenIdParamSchema,
    address: solanaAddressSchema.openapi({
      description: "Allowlisted wallet address.",
      example: "So11111111111111111111111111111111111111112",
    }),
    label: z
      .string()
      .nullable()
      .openapi({ description: "Optional label for the address.", example: "Treasury" }),
    status: z
      .enum(["active", "revoked"])
      .openapi({ description: "Allowlist entry status.", example: "active" }),
    addedBy: z.string().openapi({
      description: "Actor identifier that added the entry.",
      example: "key_example",
    }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    revokedAt: isoDateTimeSchema.nullable().openapi({
      description: "Revocation timestamp, if revoked.",
      example: "2025-02-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Token allowlist entry." });

export const frozenAccountSchema = z
  .object({
    id: frozenAccountIdSchema,
    tokenId: tokenIdParamSchema,
    accountAddress: solanaAddressSchema.openapi({
      description:
        "Wallet address associated with the frozen token holdings for this mint. SDP resolves the underlying token account automatically.",
      example: "So11111111111111111111111111111111111111112",
    }),
    reason: z
      .string()
      .nullable()
      .openapi({ description: "Reason for freezing, if provided.", example: "Compliance hold" }),
    frozenAt: isoDateTimeSchema.openapi({
      description: "Timestamp when the account was frozen.",
      example: "2025-01-05T00:00:00.000Z",
    }),
    frozenBy: z.string().openapi({
      description: "Actor identifier that froze the account.",
      example: "key_example",
    }),
    unfrozenAt: isoDateTimeSchema.nullable().openapi({
      description: "Timestamp when the account was unfrozen, if applicable.",
      example: "2025-01-10T00:00:00.000Z",
    }),
    unfrozenBy: z
      .string()
      .nullable()
      .openapi({ description: "Actor identifier that unfroze the account." }),
    signature: z.string().optional().openapi({
      description: "Solana transaction signature for the latest freeze/unfreeze.",
      example: "sig_example",
    }),
  })
  .openapi({ description: "Frozen account record." });

export const simulationResultSchema = z
  .object({
    success: z.boolean().openapi({ description: "Simulation success flag.", example: true }),
    logs: z
      .array(z.string())
      .openapi({ description: "Simulation logs, if any.", example: ["Program log: success"] }),
    unitsConsumed: z
      .union([z.number(), z.string()])
      .nullable()
      .openapi({ description: "Compute units consumed.", example: 20000 }),
    error: z
      .string()
      .nullable()
      .openapi({ description: "Simulation error, if any.", example: "Insufficient funds" }),
  })
  .openapi({ description: "Transaction simulation result." });

export const preparedTransactionSchema = z
  .object({
    serialized: base64Schema.openapi({
      description: "Base64-encoded unsigned transaction.",
      example: "AQID",
    }),
    blockhash: z
      .string()
      .openapi({ description: "Blockhash for the transaction.", example: "blockhash_example" }),
    lastValidBlockHeight: z
      .string()
      .openapi({ description: "Last valid block height.", example: "123456" }),
  })
  .openapi({ description: "Unsigned transaction payload for client-side signing." });

export const prepareDeployResponseSchema = z
  .object({
    transaction: preparedTransactionSchema.openapi({
      description: "Prepared transaction for deploying the token.",
    }),
    mint: solanaAddressSchema.openapi({
      description: "Mint address that will be created.",
      example: "So11111111111111111111111111111111111111112",
    }),
    simulation: simulationResultSchema
      .optional()
      .openapi({ description: "Optional transaction simulation results." }),
  })
  .openapi({ description: "Prepare deploy response payload." });

export const prepareMintResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Mint transaction record." }),
    preparedTransaction: preparedTransactionSchema.openapi({
      description: "Prepared transaction for minting.",
    }),
    tokenAccount: solanaAddressSchema.openapi({
      description: "Destination token account address.",
      example: "So11111111111111111111111111111111111111112",
    }),
    simulation: simulationResultSchema
      .optional()
      .openapi({ description: "Optional transaction simulation results." }),
  })
  .openapi({ description: "Prepare mint response payload." });

export const executeMintResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Mint transaction record." }),
    tokenAccount: solanaAddressSchema.openapi({
      description: "Destination token account address.",
      example: "So11111111111111111111111111111111111111112",
    }),
  })
  .openapi({ description: "Execute mint response payload." });

export const prepareBurnResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Burn transaction record." }),
    preparedTransaction: preparedTransactionSchema.openapi({
      description: "Prepared transaction for burning.",
    }),
    simulation: simulationResultSchema
      .optional()
      .openapi({ description: "Optional transaction simulation results." }),
  })
  .openapi({ description: "Prepare burn response payload." });

export const executeBurnResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Burn transaction record." }),
  })
  .openapi({ description: "Execute burn response payload." });

export const prepareSeizeResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Seize transaction record." }),
    preparedTransaction: preparedTransactionSchema.openapi({
      description: "Prepared transaction for seizure.",
    }),
    simulation: simulationResultSchema
      .optional()
      .openapi({ description: "Optional transaction simulation results." }),
  })
  .openapi({ description: "Prepare seize response payload." });

export const executeSeizeResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Seize transaction record." }),
  })
  .openapi({ description: "Execute seize response payload." });

export const prepareForceBurnResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Force burn transaction record." }),
    preparedTransaction: preparedTransactionSchema.openapi({
      description: "Prepared transaction for force burn.",
    }),
    simulation: simulationResultSchema
      .optional()
      .openapi({ description: "Optional transaction simulation results." }),
  })
  .openapi({ description: "Prepare force burn response payload." });

export const executeForceBurnResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Force burn transaction record." }),
  })
  .openapi({ description: "Execute force burn response payload." });

export const prepareUpdateAuthorityResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({
      description: "Authority update transaction record.",
    }),
    preparedTransaction: preparedTransactionSchema.openapi({
      description: "Prepared transaction for authority update.",
    }),
    simulation: simulationResultSchema
      .optional()
      .openapi({ description: "Optional transaction simulation results." }),
  })
  .openapi({ description: "Prepare authority update response payload." });

export const executeUpdateAuthorityResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({
      description: "Authority update transaction record.",
    }),
  })
  .openapi({ description: "Execute authority update response payload." });

export const executePauseResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Pause transaction record." }),
  })
  .openapi({ description: "Execute pause response payload." });

export const executeUnpauseResponseSchema = z
  .object({
    transaction: tokenTransactionSchema.openapi({ description: "Unpause transaction record." }),
  })
  .openapi({ description: "Execute unpause response payload." });

export const tokenResponseSchema = z
  .object({
    token: tokenSchema.openapi({ description: "Token details." }),
  })
  .openapi({ description: "Token response payload." });

export const tokenAllowlistResponseSchema = z
  .object({
    entry: tokenAllowlistEntrySchema.openapi({ description: "Token allowlist entry." }),
  })
  .openapi({ description: "Token allowlist entry response payload." });

export const frozenAccountResponseSchema = z
  .object({
    frozenAccount: frozenAccountSchema.openapi({ description: "Frozen account details." }),
  })
  .openapi({ description: "Frozen account response payload." });

// Extension override schema for OpenAPI documentation
const extensionOverridesOpenApiSchema = z
  .object({
    transferFee: z
      .union([
        z.literal(false),
        z.object({
          basisPoints: z.number().int().min(0).max(10000).openapi({
            description: "Transfer fee in basis points.",
            example: 50,
          }),
          maxFee: z.string().openapi({
            description: "Maximum fee in UI units.",
            example: "0.5",
          }),
          transferFeeConfigAuthority: z.string().optional().openapi({
            description: "Authority to configure transfer fees. Defaults to platform authority.",
            example: "So11111111111111111111111111111111111111112",
          }),
          withdrawWithheldAuthority: z.string().optional().openapi({
            description: "Authority to withdraw withheld fees. Defaults to platform authority.",
            example: "So11111111111111111111111111111111111111112",
          }),
        }),
      ])
      .optional()
      .openapi({ description: "Transfer fee configuration or false to disable." }),
    interestBearing: z
      .union([
        z.literal(false),
        z.object({
          rate: z.number().openapi({
            description: "Interest rate in percent.",
            example: 2.5,
          }),
          rateAuthority: z.string().optional().openapi({
            description: "Authority that can update the rate. Defaults to platform authority.",
            example: "So11111111111111111111111111111111111111112",
          }),
        }),
      ])
      .optional()
      .openapi({ description: "Interest-bearing configuration or false to disable." }),
    permanentDelegate: z
      .union([z.literal(false), z.string()])
      .optional()
      .openapi({
        description: "Permanent delegate authority address, or false to disable.",
        example: "So11111111111111111111111111111111111111112",
      }),
    pausable: z
      .union([
        z.literal(false),
        z.object({
          authority: z.string().optional().openapi({
            description:
              "Authority that can pause/resume transfers. Defaults to platform authority.",
            example: "So11111111111111111111111111111111111111112",
          }),
        }),
      ])
      .optional()
      .openapi({ description: "Pausable configuration or false to disable." }),
    nonTransferable: z.boolean().optional().openapi({
      description: "Enable/disable non-transferable.",
      example: false,
    }),
    defaultAccountState: z
      .enum(["initialized", "frozen"])
      .optional()
      .openapi({ description: "Override default account state.", example: "frozen" }),
    scaledUiAmount: z
      .union([
        z.literal(false),
        z.object({
          authority: z.string().optional().openapi({
            description:
              "Authority that can update scaled UI parameters. Defaults to platform authority.",
            example: "So11111111111111111111111111111111111111112",
          }),
          multiplier: z.number().openapi({
            description: "Current UI multiplier.",
            example: 1,
          }),
          newMultiplier: z.number().optional().openapi({
            description: "Scheduled multiplier.",
            example: 2,
          }),
          newMultiplierEffectiveTimestamp: z.number().int().optional().openapi({
            description: "Unix timestamp (seconds) when the new multiplier takes effect.",
            example: 1735689600,
          }),
        }),
      ])
      .optional()
      .openapi({ description: "Scaled UI amount configuration or false to disable." }),
    transferHook: z
      .union([
        z.literal(false),
        z.object({
          programId: z.string().openapi({
            description: "Transfer hook program id.",
            example: "So11111111111111111111111111111111111111112",
          }),
          authority: z.string().optional().openapi({
            description:
              "Authority that can update the hook program. Defaults to platform authority.",
            example: "So11111111111111111111111111111111111111112",
          }),
        }),
      ])
      .optional()
      .openapi({ description: "Transfer hook configuration or false to disable." }),
  })
  .openapi({ description: "Extension overrides to customize template defaults." });

const templateOverridesOpenApiSchema = z
  .object({
    extensions: extensionOverridesOpenApiSchema.optional().openapi({
      description: "Override template extension configuration.",
    }),
    requiresAllowlist: z.boolean().optional().openapi({
      description: "Override allowlist requirement (if template allows).",
      example: true,
    }),
  })
  .openapi({ description: "Template customization overrides." });

export const createTokenRequestSchema = createTokenSchemaBase
  .extend({
    name: withOpenApi(createTokenSchemaBase.shape.name, {
      description: "Token name.",
      example: "Example Token",
    }),
    symbol: withOpenApi(createTokenSchemaBase.shape.symbol, {
      description: "Ticker symbol.",
      example: "EXM",
    }),
    decimals: withOpenApi(createTokenSchemaBase.shape.decimals, {
      description: "Token decimals.",
      example: 6,
    }),
    description: withOpenApi(createTokenSchemaBase.shape.description, {
      description: "Token description.",
      example: "Example token description.",
    }),
    uri: withOpenApi(createTokenSchemaBase.shape.uri, {
      description: "Metadata URI passed to on-chain token metadata (points to off-chain JSON).",
      example: "https://example.com/metadata.json",
    }),
    imageUrl: withOpenApi(createTokenSchemaBase.shape.imageUrl, {
      description: "Token image URL.",
      example: "https://example.com/token.png",
    }),
    maxSupply: withOpenApi(createTokenSchemaBase.shape.maxSupply, {
      description: "Maximum supply as a string (UI units).",
      example: "1000000",
    }),
    template: withOpenApi(createTokenSchemaBase.shape.template, {
      description: "Token template preset. Defaults to 'custom' if not specified.",
      example: "stablecoin",
    }),
    signingWalletId: walletIdParamSchema.optional().openapi({
      description: "Preferred custody wallet ID for token deploy/admin/write actions.",
      example: "wal_example",
    }),
    overrides: templateOverridesOpenApiSchema.optional().openapi({
      description: "Template overrides to customize defaults.",
      example: {
        extensions: {
          transferFee: { basisPoints: 50, maxFee: "0.5" },
        },
      },
    }),
    requiresAllowlist: withOpenApi(createTokenSchemaBase.shape.requiresAllowlist, {
      description: "Require allowlist checks for transfers.",
      example: true,
    }),
    isMintable: withOpenApi(createTokenSchemaBase.shape.isMintable, {
      description: "Allow minting after creation.",
      example: true,
    }),
    isFreezable: withOpenApi(createTokenSchemaBase.shape.isFreezable, {
      description: "Allow freezing token accounts.",
      example: true,
    }),
  })
  .openapi({ description: "Create token request body." });

export const updateTokenRequestSchema = updateTokenSchemaBase
  .extend({
    name: withOpenApi(updateTokenSchemaBase.shape.name, {
      description:
        "Updated token name. For deployed tokens, this updates on-chain Token-2022 metadata using the current metadata authority.",
      example: "Example Token Updated",
    }),
    description: withOpenApi(updateTokenSchemaBase.shape.description, {
      description:
        "Updated token description. For deployed tokens, this writes the on-chain `description` metadata field. Use null to clear the displayed value.",
      example: "Updated token description.",
    }),
    uri: withOpenApi(updateTokenSchemaBase.shape.uri, {
      description:
        "Updated metadata URI. For deployed tokens, this updates the on-chain Token-2022 metadata URI using the current metadata authority. Use null to clear.",
      example: "https://example.com/metadata.json",
    }),
    imageUrl: withOpenApi(updateTokenSchemaBase.shape.imageUrl, {
      description:
        "Updated image URL. For deployed tokens, this writes the on-chain `image` metadata field. Use null to clear the displayed value.",
      example: "https://example.com/token.png",
    }),
    status: withOpenApi(updateTokenSchemaBase.shape.status, {
      description: "Token operational status.",
      example: "active",
    }),
  })
  .openapi({ description: "Update token request body." });

const mintOperationSchema = mintSchemaBase.shape.mint
  .extend({
    destination: withOpenApi(mintSchemaBase.shape.mint.shape.destination, {
      description: "Destination wallet address to receive minted tokens.",
      example: "So11111111111111111111111111111111111111112",
    }),
    amount: withOpenApi(mintSchemaBase.shape.mint.shape.amount, {
      description: ISSUANCE_TOKEN_AMOUNT_DESCRIPTION,
      example: "1000",
    }),
    memo: withOpenApi(mintSchemaBase.shape.mint.shape.memo, {
      description: "Optional on-chain memo.",
      example: "Payout",
    }),
  })
  .openapi({ description: "Mint operation details." });

export const mintRequestSchema = mintSchemaBase
  .extend({
    signingWalletId: withOpenApi(mintSchemaBase.shape.signingWalletId, {
      description: "Optional custody wallet ID to use as the signer for this action.",
      example: "wal_example",
    }),
    mint: mintOperationSchema,
    options: withOpenApi(mintSchemaBase.shape.options, {
      description: "Mint execution options.",
      example: { priorityFee: "low", simulate: true },
    }),
  })
  .openapi({ description: "Mint request body." });

const burnOperationSchema = burnSchemaBase.shape.burn
  .extend({
    source: withOpenApi(burnSchemaBase.shape.burn.shape.source, {
      description: "Source wallet or token account to burn from.",
      example: "So11111111111111111111111111111111111111112",
    }),
    amount: withOpenApi(burnSchemaBase.shape.burn.shape.amount, {
      description: ISSUANCE_TOKEN_AMOUNT_DESCRIPTION,
      example: "1000",
    }),
    memo: withOpenApi(burnSchemaBase.shape.burn.shape.memo, {
      description: "Optional on-chain memo.",
      example: "Correction",
    }),
  })
  .openapi({ description: "Burn operation details." });

export const burnRequestSchema = burnSchemaBase
  .extend({
    signingWalletId: withOpenApi(burnSchemaBase.shape.signingWalletId, {
      description: "Optional custody wallet ID to use as the signer for this action.",
      example: "wal_example",
    }),
    burn: burnOperationSchema,
    options: withOpenApi(burnSchemaBase.shape.options, {
      description: "Burn execution options.",
      example: { priorityFee: "low", simulate: true },
    }),
  })
  .openapi({ description: "Burn request body." });

const seizeOperationSchema = seizeSchemaBase.shape.seize
  .extend({
    source: withOpenApi(seizeSchemaBase.shape.seize.shape.source, {
      description: "Source wallet or token account to seize from.",
      example: "So11111111111111111111111111111111111111112",
    }),
    destination: withOpenApi(seizeSchemaBase.shape.seize.shape.destination, {
      description: "Destination wallet or token account to receive seized tokens.",
      example: "So11111111111111111111111111111111111111112",
    }),
    amount: withOpenApi(seizeSchemaBase.shape.seize.shape.amount, {
      description: ISSUANCE_TOKEN_AMOUNT_DESCRIPTION,
      example: "250",
    }),
    delegateAuthority: withOpenApi(seizeSchemaBase.shape.seize.shape.delegateAuthority, {
      description: "Optional delegate authority address for the seizure.",
      example: "So11111111111111111111111111111111111111112",
    }),
    memo: withOpenApi(seizeSchemaBase.shape.seize.shape.memo, {
      description: "Optional on-chain memo.",
      example: "Compliance seizure",
    }),
  })
  .openapi({ description: "Forced transfer details." });

export const seizeRequestSchema = seizeSchemaBase
  .extend({
    signingWalletId: withOpenApi(seizeSchemaBase.shape.signingWalletId, {
      description: "Optional custody wallet ID to use as the signer for this action.",
      example: "wal_example",
    }),
    seize: seizeOperationSchema,
    options: withOpenApi(seizeSchemaBase.shape.options, {
      description: "Seize execution options.",
      example: { priorityFee: "low", simulate: true },
    }),
  })
  .openapi({ description: "Seize (force transfer) request body." });

const forceBurnOperationSchema = forceBurnSchemaBase.shape.forceBurn
  .extend({
    source: withOpenApi(forceBurnSchemaBase.shape.forceBurn.shape.source, {
      description: "Source wallet or token account to force-burn from.",
      example: "So11111111111111111111111111111111111111112",
    }),
    amount: withOpenApi(forceBurnSchemaBase.shape.forceBurn.shape.amount, {
      description: ISSUANCE_TOKEN_AMOUNT_DESCRIPTION,
      example: "250",
    }),
    delegateAuthority: withOpenApi(forceBurnSchemaBase.shape.forceBurn.shape.delegateAuthority, {
      description: "Optional delegate authority address for the force burn.",
      example: "So11111111111111111111111111111111111111112",
    }),
    memo: withOpenApi(forceBurnSchemaBase.shape.forceBurn.shape.memo, {
      description: "Optional on-chain memo.",
      example: "Compliance burn",
    }),
  })
  .openapi({ description: "Forced burn details." });

export const forceBurnRequestSchema = forceBurnSchemaBase
  .extend({
    signingWalletId: withOpenApi(forceBurnSchemaBase.shape.signingWalletId, {
      description: "Optional custody wallet ID to use as the signer for this action.",
      example: "wal_example",
    }),
    forceBurn: forceBurnOperationSchema,
    options: withOpenApi(forceBurnSchemaBase.shape.options, {
      description: "Force burn execution options.",
      example: { priorityFee: "low", simulate: true },
    }),
  })
  .openapi({ description: "Force burn request body." });

export const updateAuthorityRequestSchema = updateAuthoritySchemaBase
  .extend({
    signingWalletId: withOpenApi(updateAuthoritySchemaBase.shape.signingWalletId, {
      description: "Optional custody wallet ID to use as the signer for this action.",
      example: "wal_example",
    }),
    authority: withOpenApi(updateAuthoritySchemaBase.shape.authority, {
      description: "Authority update details.",
      example: {
        role: "mint",
        newAuthority: "So11111111111111111111111111111111111111112",
      },
    }),
    options: withOpenApi(updateAuthoritySchemaBase.shape.options, {
      description: "Authority update options.",
      example: { priorityFee: "low", simulate: true },
    }),
  })
  .openapi({ description: "Update authority request body." });

export const pauseTokenRequestSchema = pauseTokenSchemaBase
  .extend({
    options: withOpenApi(pauseTokenSchemaBase.shape.options, {
      description: "Pause/unpause options.",
      example: { priorityFee: "low", simulate: true },
    }),
  })
  .openapi({ description: "Pause token request body." });

export const freezeAccountRequestSchema = freezeSchemaBase
  .extend({
    accountAddress: withOpenApi(freezeSchemaBase.shape.accountAddress, {
      description:
        "Wallet or token account address to freeze. SDP resolves the associated token account automatically when a wallet address is provided.",
      example: "So11111111111111111111111111111111111111112",
    }),
    reason: withOpenApi(freezeSchemaBase.shape.reason, {
      description: "Optional reason for freezing.",
      example: "Compliance hold",
    }),
    signingWalletId: withOpenApi(freezeSchemaBase.shape.signingWalletId, {
      description: "Optional custody wallet ID to use as the signer for this request.",
      example: "privy_abcd1234",
    }),
  })
  .openapi({ description: "Freeze account request body." });

export const unfreezeAccountRequestSchema = unfreezeSchemaBase
  .extend({
    accountAddress: withOpenApi(unfreezeSchemaBase.shape.accountAddress, {
      description:
        "Wallet or token account address to unfreeze. SDP resolves the associated token account automatically when a wallet address is provided.",
      example: "So11111111111111111111111111111111111111112",
    }),
    signingWalletId: withOpenApi(unfreezeSchemaBase.shape.signingWalletId, {
      description: "Optional custody wallet ID to use as the signer for this request.",
      example: "privy_abcd1234",
    }),
  })
  .openapi({ description: "Unfreeze account request body." });

export const addTokenAllowlistRequestSchema = addTokenAllowlistSchemaBase
  .extend({
    address: withOpenApi(addTokenAllowlistSchemaBase.shape.address, {
      description: "Wallet address to allowlist.",
      example: "So11111111111111111111111111111111111111112",
    }),
    label: withOpenApi(addTokenAllowlistSchemaBase.shape.label, {
      description: "Optional label for the allowlist entry.",
      example: "Treasury",
    }),
  })
  .openapi({ description: "Add token allowlist entry request body." });

// ═══════════════════════════════════════════════════════════════════════════
// Template Schemas
// ═══════════════════════════════════════════════════════════════════════════

export const extensionStatusSchema = z.enum(["implemented", "disabled", "planned"]).openapi({
  description: "Extension implementation status.",
  example: "implemented",
});

export const templateExtensionInfoSchema = z
  .object({
    name: z.string().openapi({
      description: "Extension identifier.",
      example: "transferFee",
    }),
    status: extensionStatusSchema,
    enabled: z.boolean().openapi({
      description: "Whether the extension feature flag is enabled.",
      example: true,
    }),
  })
  .openapi({ description: "Extension info with implementation status." });

const tokenTemplateExtensionSchema = z
  .enum([
    "transferFee",
    "interestBearing",
    "permanentDelegate",
    "pausable",
    "nonTransferable",
    "defaultAccountState",
    "scaledUiAmount",
    "transferHook",
  ])
  .openapi({
    description: "Token-2022 extension name.",
    example: "transferFee",
  });

export const tokenTemplateInfoSchema = z
  .object({
    id: tokenTemplateIdSchema,
    name: z.string().openapi({
      description: "Human-readable template name.",
      example: "Stablecoin",
    }),
    description: z.string().optional().openapi({
      description: "Template description and use case.",
      example: "USD-backed stablecoins with compliance controls and privacy features",
    }),
    decimals: z.number().int().openapi({
      description: "Default decimals for the template.",
      example: 6,
    }),
    maxDecimals: z.number().int().openapi({
      description: "Maximum allowed decimals for this template.",
      example: 18,
    }),
    requiresAllowlist: z.boolean().openapi({
      description: "Whether allowlists are required for this template by default.",
      example: true,
    }),
    allowlistOverridable: z.boolean().openapi({
      description: "Whether allowlist enforcement can be disabled by request.",
      example: true,
    }),
    requiredExtensions: z.array(tokenTemplateExtensionSchema).openapi({
      description: "Required Token-2022 extensions for this template.",
      example: ["permanentDelegate", "pausable"],
    }),
    availableExtensions: z.array(tokenTemplateExtensionSchema).openapi({
      description: "Extensions that can be configured for this template.",
      example: ["scaledUiAmount", "interestBearing"],
    }),
    defaultExtensions: z.record(z.string(), z.unknown()).openapi({
      description: "Default extension values used by this template.",
      example: {
        defaultAccountState: "initialized",
      },
    }),
  })
  .openapi({ description: "Token template information." });

export const tokenTemplateResponseSchema = z
  .object({
    template: tokenTemplateInfoSchema.openapi({ description: "Template details." }),
  })
  .openapi({ description: "Token template response payload." });

export const listTemplatesResponseSchema = z
  .object({
    templates: z.array(tokenTemplateInfoSchema).openapi({
      description: "List of available token templates.",
    }),
  })
  .openapi({ description: "List templates response payload." });

export const templateIdParamSchema = z.string().openapi({
  description: "Template identifier.",
  example: "stablecoin",
});
