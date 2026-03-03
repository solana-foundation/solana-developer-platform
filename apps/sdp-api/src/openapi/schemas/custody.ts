import {
  createWalletSchema as createWalletSchemaBase,
  deleteWalletSchema as deleteWalletSchemaBase,
  initializeSigningSchema as initializeSigningSchemaBase,
  setDefaultWalletSchema as setDefaultWalletSchemaBase,
  signerCheckSchema as signerCheckSchemaBase,
  switchSigningSchema as switchSigningSchemaBase,
} from "../../routes/custody/schemas";
import { z } from "./base";
import {
  isoDateTimeSchema,
  projectIdParamSchema,
  solanaAddressSchema,
  walletIdParamSchema,
} from "./base";

export const initializeSigningRequestSchema = initializeSigningSchemaBase.openapi({
  description: "Initialize wallet signing provider for the organization or project.",
});

export const switchSigningRequestSchema = switchSigningSchemaBase.openapi({
  description: "Switch the active wallet signing provider for the organization or project.",
});

export const signerCheckRequestSchema = signerCheckSchemaBase.openapi({
  description:
    "Optional memo payload for signer check. Signing wallet is resolved from the API key binding.",
});

export const orgCustodyProviderSchema = z
  .enum(["local", "fireblocks", "privy", "coinbase_cdp", "para", "turnkey", "dfns", "anchorage"])
  .openapi({ description: "Wallet signing provider.", example: "privy" });

export const createCustodyWalletRequestSchema = createWalletSchemaBase
  .extend({
    projectId: projectIdParamSchema.optional(),
    provider: orgCustodyProviderSchema.optional().openapi({
      description:
        "Optional provider target. Defaults to the currently resolved default provider for the scope.",
      example: "privy",
    }),
    label: createWalletSchemaBase.shape.label.openapi({
      description: "Optional label for the new wallet.",
      example: "Mint authority wallet",
    }),
    purpose: createWalletSchemaBase.shape.purpose.openapi({
      description: "Optional semantic purpose for the wallet.",
      example: "mint_authority",
    }),
    setDefault: createWalletSchemaBase.shape.setDefault.openapi({
      description: "Set this wallet as the default signer for the active wallet signing config.",
      example: true,
    }),
  })
  .openapi({ description: "Create wallet request body." });

export const setDefaultWalletRequestSchema = setDefaultWalletSchemaBase
  .extend({
    projectId: projectIdParamSchema.optional(),
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
    projectId: projectIdParamSchema.optional(),
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

export const custodyWalletSchema = z
  .object({
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
  })
  .openapi({ description: "Wallet details." });

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
