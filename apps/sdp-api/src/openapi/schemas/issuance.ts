import {
  addAllowlistSchema as addTokenAllowlistSchemaBase,
  burnSchema as burnSchemaBase,
  createTokenSchema as createTokenSchemaBase,
  freezeSchema as freezeSchemaBase,
  mintSchema as mintSchemaBase,
  unfreezeSchema as unfreezeSchemaBase,
  updateTokenSchema as updateTokenSchemaBase,
} from "../../routes/issuance/schemas";
import { z } from "./base";
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
} from "./base";

export const tokenExtensionsConfigSchema = z
  .object({
    confidentialTransfer: z.boolean().optional().openapi({
      description: "Enable confidential transfer extension.",
      example: false,
    }),
    transferFee: z
      .object({
        basisPoints: z.number().int().min(0).max(10000).openapi({
          description: "Transfer fee in basis points (0-10000).",
          example: 25,
        }),
        maxFee: z.string().openapi({
          description: "Maximum fee in base units.",
          example: "1000000",
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
    nonTransferable: z
      .boolean()
      .optional()
      .openapi({ description: "Mark token as non-transferable.", example: false }),
    defaultAccountState: z
      .enum(["initialized", "frozen"])
      .optional()
      .openapi({ description: "Default account state.", example: "initialized" }),
    metadataPointer: z
      .object({
        authority: solanaAddressSchema.openapi({
          description: "Metadata pointer authority.",
          example: "So11111111111111111111111111111111111111112",
        }),
        metadataAddress: solanaAddressSchema.openapi({
          description: "Metadata account address.",
          example: "So11111111111111111111111111111111111111112",
        }),
      })
      .optional()
      .openapi({ description: "Metadata pointer configuration." }),
    groupPointer: z
      .object({
        authority: solanaAddressSchema.openapi({
          description: "Group pointer authority.",
          example: "So11111111111111111111111111111111111111112",
        }),
        groupAddress: solanaAddressSchema.openapi({
          description: "Group address.",
          example: "So11111111111111111111111111111111111111112",
        }),
      })
      .optional()
      .openapi({ description: "Group pointer configuration." }),
  })
  .strict()
  .openapi({ description: "Token-2022 extensions configuration." });

export const tokenSchema = z
  .object({
    id: tokenIdParamSchema,
    projectId: projectIdParamSchema,
    organizationId: orgIdParamSchema,
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
    name: z.string().openapi({ description: "Token name.", example: "Example Token" }),
    symbol: z.string().openapi({ description: "Token symbol.", example: "EXM" }),
    decimals: z.number().int().openapi({ description: "Token decimals.", example: 9 }),
    description: z
      .string()
      .nullable()
      .openapi({ description: "Token description.", example: "Example token description." }),
    uri: z
      .string()
      .nullable()
      .openapi({ description: "Metadata URI.", example: "https://example.com/metadata.json" }),
    imageUrl: z
      .string()
      .nullable()
      .openapi({ description: "Token image URL.", example: "https://example.com/token.png" }),
    extensions: tokenExtensionsConfigSchema
      .nullable()
      .openapi({ description: "Token-2022 extensions configuration." }),
    totalSupply: z
      .string()
      .openapi({ description: "Total supply in base units.", example: "1000000" }),
    maxSupply: z
      .string()
      .nullable()
      .openapi({ description: "Maximum supply in base units, if capped.", example: "10000000" }),
    isMintable: z
      .boolean()
      .openapi({ description: "Whether additional minting is allowed.", example: true }),
    isFreezable: z
      .boolean()
      .openapi({ description: "Whether accounts can be frozen.", example: true }),
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
      .enum(["mint", "burn", "freeze", "unfreeze"])
      .openapi({ description: "Transaction type.", example: "mint" }),
    status: z
      .enum(["pending", "processing", "confirmed", "finalized", "failed"])
      .openapi({ description: "Transaction status.", example: "confirmed" }),
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
    blockTime: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Block time (unix epoch), if confirmed.", example: 1700000000 }),
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
    kycStatus: z
      .enum(["none", "pending", "approved", "rejected"])
      .openapi({ description: "KYC status.", example: "approved" }),
    kycProvider: z
      .string()
      .nullable()
      .openapi({ description: "KYC provider name.", example: "ExampleKYC" }),
    kycVerifiedAt: isoDateTimeSchema.nullable().openapi({
      description: "Timestamp when KYC was verified, if any.",
      example: "2025-01-05T00:00:00.000Z",
    }),
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
      description: "Token account or owner address that is frozen.",
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

export const createTokenRequestSchema = createTokenSchemaBase
  .extend({
    name: createTokenSchemaBase.shape.name.openapi({
      description: "Token name.",
      example: "Example Token",
    }),
    symbol: createTokenSchemaBase.shape.symbol.openapi({
      description: "Ticker symbol.",
      example: "EXM",
    }),
    decimals: createTokenSchemaBase.shape.decimals.openapi({
      description: "Token decimals. Defaults to 9.",
      example: 9,
    }),
    description: createTokenSchemaBase.shape.description.openapi({
      description: "Token description.",
      example: "Example token description.",
    }),
    uri: createTokenSchemaBase.shape.uri.openapi({
      description: "Metadata URI.",
      example: "https://example.com/metadata.json",
    }),
    imageUrl: createTokenSchemaBase.shape.imageUrl.openapi({
      description: "Token image URL.",
      example: "https://example.com/token.png",
    }),
    maxSupply: createTokenSchemaBase.shape.maxSupply.openapi({
      description: "Maximum supply as a string (base units).",
      example: "1000000",
    }),
    template: createTokenSchemaBase.shape.template.openapi({
      description: "Token template preset.",
      example: "stablecoin",
    }),
    extensions: createTokenSchemaBase.shape.extensions.openapi({
      description: "Token-2022 extension configuration.",
      example: {
        confidentialTransfer: false,
        defaultAccountState: "initialized",
      },
    }),
    requiresAllowlist: createTokenSchemaBase.shape.requiresAllowlist.openapi({
      description: "Require allowlist checks for transfers.",
      example: true,
    }),
    isMintable: createTokenSchemaBase.shape.isMintable.openapi({
      description: "Allow minting after creation.",
      example: true,
    }),
    isFreezable: createTokenSchemaBase.shape.isFreezable.openapi({
      description: "Allow freezing token accounts.",
      example: true,
    }),
  })
  .openapi({ description: "Create token request body." });

export const updateTokenRequestSchema = updateTokenSchemaBase
  .extend({
    name: updateTokenSchemaBase.shape.name.openapi({
      description: "Updated token name.",
      example: "Example Token Updated",
    }),
    description: updateTokenSchemaBase.shape.description.openapi({
      description: "Updated description. Use null to clear.",
      example: "Updated token description.",
    }),
    uri: updateTokenSchemaBase.shape.uri.openapi({
      description: "Updated metadata URI. Use null to clear.",
      example: "https://example.com/metadata.json",
    }),
    imageUrl: updateTokenSchemaBase.shape.imageUrl.openapi({
      description: "Updated image URL. Use null to clear.",
      example: "https://example.com/token.png",
    }),
    status: updateTokenSchemaBase.shape.status.openapi({
      description: "Token operational status.",
      example: "active",
    }),
  })
  .openapi({ description: "Update token request body." });

export const mintRequestSchema = mintSchemaBase
  .extend({
    mint: mintSchemaBase.shape.mint.openapi({
      description: "Mint operation details.",
      example: {
        destination: "So11111111111111111111111111111111111111112",
        amount: "1000",
        memo: "Payout",
      },
    }),
    options: mintSchemaBase.shape.options.openapi({
      description: "Mint execution options.",
      example: { priorityFee: "low", simulate: true },
    }),
  })
  .openapi({ description: "Mint request body." });

export const burnRequestSchema = burnSchemaBase
  .extend({
    burn: burnSchemaBase.shape.burn.openapi({
      description: "Burn operation details.",
      example: {
        source: "So11111111111111111111111111111111111111112",
        amount: "1000",
        memo: "Correction",
      },
    }),
    options: burnSchemaBase.shape.options.openapi({
      description: "Burn execution options.",
      example: { priorityFee: "low", simulate: true },
    }),
  })
  .openapi({ description: "Burn request body." });

export const freezeAccountRequestSchema = freezeSchemaBase
  .extend({
    accountAddress: freezeSchemaBase.shape.accountAddress.openapi({
      description: "Token account or owner address to freeze.",
      example: "So11111111111111111111111111111111111111112",
    }),
    reason: freezeSchemaBase.shape.reason.openapi({
      description: "Optional reason for freezing.",
      example: "Compliance hold",
    }),
  })
  .openapi({ description: "Freeze account request body." });

export const unfreezeAccountRequestSchema = unfreezeSchemaBase
  .extend({
    accountAddress: unfreezeSchemaBase.shape.accountAddress.openapi({
      description: "Token account or owner address to unfreeze.",
      example: "So11111111111111111111111111111111111111112",
    }),
  })
  .openapi({ description: "Unfreeze account request body." });

export const addTokenAllowlistRequestSchema = addTokenAllowlistSchemaBase
  .extend({
    address: addTokenAllowlistSchemaBase.shape.address.openapi({
      description: "Wallet address to allowlist.",
      example: "So11111111111111111111111111111111111111112",
    }),
    label: addTokenAllowlistSchemaBase.shape.label.openapi({
      description: "Optional label for the allowlist entry.",
      example: "Treasury",
    }),
    kycStatus: addTokenAllowlistSchemaBase.shape.kycStatus.openapi({
      description: "KYC status for the address.",
      example: "approved",
    }),
    kycProvider: addTokenAllowlistSchemaBase.shape.kycProvider.openapi({
      description: "KYC provider name.",
      example: "ExampleKYC",
    }),
  })
  .openapi({ description: "Add token allowlist entry request body." });
