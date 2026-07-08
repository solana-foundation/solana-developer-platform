import {
  createWalletSchema as createWalletSchemaBase,
  deleteWalletSchema as deleteWalletSchemaBase,
  initializeSigningSchema as initializeSigningSchemaBase,
  setDefaultWalletSchema as setDefaultWalletSchemaBase,
  signerCheckSchema as signerCheckSchemaBase,
  switchSigningSchema as switchSigningSchemaBase,
  updateWalletSchema as updateWalletSchemaBase,
} from "../../routes/custody/schemas";
import {
  isoDateTimeSchema,
  projectIdParamSchema,
  solanaAddressSchema,
  walletIdParamSchema,
  withOpenApi,
  z,
} from "./base";

export const initializeSigningRequestSchema = withOpenApi(initializeSigningSchemaBase, {
  description:
    "Initialize wallet signing provider for the project resolved from the request context.",
});

export const switchSigningRequestSchema = withOpenApi(switchSigningSchemaBase, {
  description:
    "Switch the active wallet signing provider for the project resolved from the request context.",
});

export const signerCheckRequestSchema = withOpenApi(signerCheckSchemaBase, {
  description:
    "Optional memo payload for signer check. Signing wallet is resolved from the API key binding.",
});

export const orgCustodyProviderSchema = z
  .enum([
    "local",
    "fireblocks",
    "privy",
    "coinbase_cdp",
    "para",
    "turnkey",
    "dfns",
    "ibm_haven",
    "anchorage",
  ])
  .openapi({ description: "Wallet signing provider.", example: "privy" });

export const createCustodyWalletRequestSchema = createWalletSchemaBase
  .extend({
    provider: orgCustodyProviderSchema.optional().openapi({
      description:
        "Optional provider target. Defaults to the currently resolved default provider for the scope.",
      example: "privy",
    }),
    label: withOpenApi(createWalletSchemaBase.shape.label, {
      description: "Optional label for the new wallet.",
      example: "Mint authority wallet",
    }),
    purpose: withOpenApi(createWalletSchemaBase.shape.purpose, {
      description: "Optional semantic purpose for the wallet.",
      example: "mint_authority",
    }),
    setDefault: withOpenApi(createWalletSchemaBase.shape.setDefault, {
      description: "Set this wallet as the default signer for the active wallet signing config.",
      example: true,
    }),
  })
  .openapi({ description: "Create wallet request body." });

export const setDefaultWalletRequestSchema = setDefaultWalletSchemaBase
  .extend({
    provider: orgCustodyProviderSchema.optional().openapi({
      description:
        "Optional provider target. Defaults to the currently resolved default provider for the scope.",
      example: "privy",
    }),
    walletId: walletIdParamSchema.openapi({
      description: "Wallet ID to set as default for the active wallet signing config.",
      example: "privy_wallet_123",
    }),
  })
  .openapi({ description: "Set default wallet request body." });

export const deleteWalletRequestSchema = deleteWalletSchemaBase
  .extend({
    provider: orgCustodyProviderSchema.optional().openapi({
      description:
        "Optional provider target. Defaults to the currently resolved default provider for the scope.",
      example: "anchorage",
    }),
    walletId: walletIdParamSchema.openapi({
      description: "Wallet ID to delete from the selected provider configuration.",
      example: "anchorage_wallet_123",
    }),
  })
  .openapi({ description: "Delete wallet request body." });

export const updateCustodyWalletRequestSchema = updateWalletSchemaBase
  .extend({
    label: withOpenApi(updateWalletSchemaBase.shape.label, {
      description: "Optional wallet label. Set to null to clear the label.",
      example: "Treasury signer",
    }),
  })
  .openapi({ description: "Update wallet request body." });

export const initializeSigningResponseSchema = z
  .object({
    configId: z.string().openapi({
      description: "Created wallet signing config ID.",
      example: "cfg_example",
    }),
    publicKey: solanaAddressSchema.openapi({
      description: "Public key of the provisioned root wallet.",
    }),
    walletId: walletIdParamSchema.openapi({
      description: "Provider wallet ID of the provisioned root wallet.",
      example: "privy_wallet_123",
    }),
  })
  .openapi({ description: "Wallet signing initialization result." });

const custodyWalletBaseSchema = z.object({
  id: z.string().openapi({ description: "Wallet record ID.", example: "cw_example" }),
  custodyConfigId: z.string().optional().openapi({
    description: "Owning custody configuration ID.",
    example: "cfg_example",
  }),
  provider: orgCustodyProviderSchema.optional(),
  isDefaultProvider: z.boolean().optional().openapi({
    description: "Whether this wallet belongs to the current default provider config.",
    example: true,
  }),
  walletId: walletIdParamSchema.openapi({
    description: "Provider wallet ID.",
    example: "privy_wallet_123",
  }),
  publicKey: solanaAddressSchema,
  label: z.string().nullable().openapi({
    description: "Optional wallet label.",
    example: "Root Signing Wallet",
  }),
  purpose: z
    .enum(["root", "mint_authority", "freeze_authority", "fee_payer", "transfer"])
    .nullable()
    .openapi({ description: "Optional wallet purpose.", example: "root" }),
  status: z.enum(["active", "inactive"]).openapi({
    description: "Wallet status.",
    example: "active",
  }),
  createdAt: isoDateTimeSchema,
});

const custodyWalletTokenBalanceSchema = z
  .object({
    token: z.string().openapi({
      description: "Tracked token symbol.",
      example: "USDC",
    }),
    mint: solanaAddressSchema.openapi({
      description: "Tracked token mint address.",
      example: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    }),
    amount: z.string().openapi({
      description: "Raw token amount as a string.",
      example: "1250000",
    }),
    uiAmount: z.string().openapi({
      description: "Human-readable token balance.",
      example: "1.25",
    }),
    decimals: z.number().int().nonnegative().openapi({
      description: "Token decimals.",
      example: 6,
    }),
    usdPrice: z.number().optional().openapi({
      description: "Resolved USD price per token when available.",
      example: 1,
    }),
    usdValue: z.number().optional().openapi({
      description: "Resolved USD value of this balance when pricing is available.",
      example: 125.5,
    }),
  })
  .openapi({ description: "Tracked fungible token balance." });

export const custodyWalletSchema = custodyWalletBaseSchema
  .extend({
    balances: z.array(custodyWalletTokenBalanceSchema).optional().openapi({
      description: "Optional tracked token balances for the wallet.",
    }),
  })
  .openapi({
    description: "Wallet details.",
  });

export const custodyWalletResponseSchema = z
  .object({
    wallet: custodyWalletSchema,
  })
  .openapi({ description: "Created wallet response payload." });

export const custodyWalletsResponseSchema = z
  .object({
    wallets: z.array(custodyWalletSchema).openapi({ description: "Wallets." }),
  })
  .openapi({ description: "Wallets list response payload." });

export const custodyWalletAggregateResponseSchema = z
  .object({
    aggregate: z
      .object({
        walletCount: z.number().int().nonnegative().openapi({
          description: "Number of wallets included in the aggregate.",
          example: 3,
        }),
        balances: z.array(custodyWalletTokenBalanceSchema).openapi({
          description: "Aggregated tracked token balances across the included wallets.",
        }),
      })
      .openapi({ description: "Aggregated wallet balance summary." }),
  })
  .openapi({ description: "Aggregated wallet balance response payload." });

export const custodyWalletByIdResponseSchema = z
  .object({
    wallet: custodyWalletBaseSchema
      .extend({
        custodyConfigId: z.string().openapi({
          description: "Owning custody configuration ID.",
          example: "cfg_example",
        }),
        provider: orgCustodyProviderSchema.openapi({
          description: "Wallet custody provider.",
          example: "privy",
        }),
        balance: z
          .object({
            token: z.literal("SOL").openapi({
              description: "Balance token symbol.",
              example: "SOL",
            }),
            mint: z.string().openapi({
              description: "Native SOL mint address.",
              example: "So11111111111111111111111111111111111111112",
            }),
            amount: z.string().openapi({
              description: "Raw lamports balance as a string.",
              example: "123456789",
            }),
            uiAmount: z.string().openapi({
              description: "Human-readable SOL balance.",
              example: "0.123456789",
            }),
            decimals: z.literal(9).openapi({
              description: "Token decimals for SOL.",
              example: 9,
            }),
          })
          .openapi({ description: "Current SOL balance for the wallet public key." }),
      })
      .openapi({ description: "Wallet details with provider and SOL balance." }),
  })
  .openapi({ description: "Wallet details by ID response payload." });

const orgCustodyConfigBaseSchema = z.object({
  id: z.string().openapi({ description: "Wallet signing config ID.", example: "cfg_example" }),
  organizationId: z.string().openapi({
    description: "Organization ID that owns this wallet signing config.",
    example: "org_example",
  }),
  projectId: projectIdParamSchema
    .nullable()
    .openapi({ description: "Optional project scope for this config." }),
  provider: orgCustodyProviderSchema,
  publicKey: solanaAddressSchema.openapi({
    description: "Public key associated with the current default wallet.",
  }),
  defaultWalletId: walletIdParamSchema
    .nullable()
    .openapi({ description: "Default provider wallet ID." }),
  status: z.enum(["active", "inactive"]).openapi({
    description: "Config status.",
    example: "active",
  }),
  createdAt: isoDateTimeSchema,
});

export const orgCustodyConfigSchema = orgCustodyConfigBaseSchema.openapi({
  description: "Wallet signing configuration details.",
});

export const custodyConfigResponseSchema = z
  .object({
    config: orgCustodyConfigSchema,
  })
  .openapi({ description: "Wallet signing configuration response payload." });

export const custodyConfigsResponseSchema = z
  .object({
    configs: z
      .array(
        orgCustodyConfigBaseSchema.extend({
          isDefault: z.boolean().openapi({
            description:
              "Whether this configuration is currently the default provider for the scope.",
            example: true,
          }),
        })
      )
      .openapi({ description: "Active wallet signing configurations for the requested scope." }),
    defaultConfigId: z.string().nullable().openapi({
      description: "Resolved default custody configuration ID for the requested scope.",
      example: "cfg_example",
    }),
  })
  .openapi({ description: "Wallet signing configurations response payload." });

export const switchProviderOptionsResponseSchema = z
  .object({
    providers: z.array(
      z.object({
        provider: orgCustodyProviderSchema,
        hasReusableWallet: z.boolean().openapi({
          description: "Whether an existing wallet can be reused for this provider.",
          example: true,
        }),
        needsWalletLabel: z.boolean().openapi({
          description: "Whether the switch flow should prompt for a wallet label.",
          example: false,
        }),
        isActive: z.boolean().openapi({
          description: "Whether this provider is currently active for the requested scope.",
          example: true,
        }),
        isDefault: z.boolean().openapi({
          description: "Whether this provider is the current default for the requested scope.",
          example: false,
        }),
      })
    ),
  })
  .openapi({ description: "Provider switch options with activity/default metadata." });

export const setDefaultWalletResponseSchema = z
  .object({
    defaultWalletId: walletIdParamSchema.openapi({
      description: "Wallet ID set as default.",
      example: "privy_wallet_123",
    }),
  })
  .openapi({ description: "Set default wallet response payload." });

export const deleteWalletResponseSchema = z
  .object({
    walletId: walletIdParamSchema.openapi({
      description: "Wallet ID that was deleted.",
      example: "anchorage_wallet_123",
    }),
    deleted: z.literal(true).openapi({
      description: "Deletion confirmation flag.",
      example: true,
    }),
  })
  .openapi({ description: "Delete wallet response payload." });

export const custodyPublicKeyResponseSchema = z
  .object({
    publicKey: solanaAddressSchema,
  })
  .openapi({ description: "Wallet public key response payload." });

export const signerCheckResponseSchema = z
  .object({
    walletId: walletIdParamSchema.openapi({
      description: "Signing wallet ID bound to the API key.",
      example: "privy_wallet_123",
    }),
    walletAddress: solanaAddressSchema.openapi({
      description: "Resolved signer address used for the memo transaction.",
    }),
    feePayer: solanaAddressSchema.openapi({
      description: "Fee payer address (Kora signer).",
    }),
    memo: z.string().openapi({
      description: "Memo text submitted on-chain.",
      example: "SDP signer check 2026-02-20T00:00:00.000Z",
    }),
    signature: z.string().openapi({
      description: "Submitted Solana transaction signature.",
      example: "sig_example",
    }),
    slot: z.number().int().openapi({
      description: "Confirmed slot number.",
      example: 123456789,
    }),
    blockTime: isoDateTimeSchema.openapi({
      description: "Timestamp recorded after confirmation.",
      example: "2026-02-20T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Signer check response payload." });
