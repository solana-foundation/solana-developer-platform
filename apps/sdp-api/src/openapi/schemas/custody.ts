import {
  createWalletSchema as createWalletSchemaBase,
  initializeSigningSchema as initializeSigningSchemaBase,
  setDefaultWalletSchema as setDefaultWalletSchemaBase,
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
  description: "Initialize custody provider for the organization or project.",
});

export const switchSigningRequestSchema = switchSigningSchemaBase.openapi({
  description: "Switch the active custody provider for the organization or project.",
});

export const createCustodyWalletRequestSchema = createWalletSchemaBase
  .extend({
    projectId: projectIdParamSchema.optional(),
    label: createWalletSchemaBase.shape.label.openapi({
      description: "Optional label for the new wallet.",
      example: "Mint authority wallet",
    }),
    purpose: createWalletSchemaBase.shape.purpose.openapi({
      description: "Optional semantic purpose for the wallet.",
      example: "mint_authority",
    }),
    setDefault: createWalletSchemaBase.shape.setDefault.openapi({
      description: "Set this wallet as the default signer for the active custody config.",
      example: true,
    }),
  })
  .openapi({ description: "Create custody wallet request body." });

export const setDefaultWalletRequestSchema = setDefaultWalletSchemaBase
  .extend({
    projectId: projectIdParamSchema.optional(),
    walletId: walletIdParamSchema.openapi({
      description: "Wallet ID to set as default for the active custody config.",
      example: "privy_wallet_123",
    }),
  })
  .openapi({ description: "Set default wallet request body." });

export const initializeSigningResponseSchema = z
  .object({
    configId: z.string().openapi({
      description: "Created custody config ID.",
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
  .openapi({ description: "Custody initialization result." });

export const orgCustodyProviderSchema = z
  .enum(["local", "fireblocks", "privy"])
  .openapi({ description: "Custody provider.", example: "privy" });

export const custodyWalletSchema = z
  .object({
    id: z.string().openapi({ description: "Custody wallet record ID.", example: "cw_example" }),
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
  .openapi({ description: "Custody wallet details." });

export const custodyWalletResponseSchema = z
  .object({
    wallet: custodyWalletSchema,
  })
  .openapi({ description: "Created custody wallet response payload." });

export const custodyWalletsResponseSchema = z
  .object({
    wallets: z.array(custodyWalletSchema).openapi({ description: "Custody wallets." }),
  })
  .openapi({ description: "Custody wallets list response payload." });

export const orgCustodyConfigSchema = z
  .object({
    id: z.string().openapi({ description: "Custody config ID.", example: "cfg_example" }),
    organizationId: z.string().openapi({
      description: "Organization ID that owns this custody config.",
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
  })
  .openapi({ description: "Custody configuration details." });

export const custodyConfigResponseSchema = z
  .object({
    config: orgCustodyConfigSchema,
  })
  .openapi({ description: "Custody configuration response payload." });

export const setDefaultWalletResponseSchema = z
  .object({
    defaultWalletId: walletIdParamSchema.openapi({
      description: "Wallet ID set as default.",
      example: "privy_wallet_123",
    }),
  })
  .openapi({ description: "Set default wallet response payload." });

export const custodyPublicKeyResponseSchema = z
  .object({
    publicKey: solanaAddressSchema,
  })
  .openapi({ description: "Custody public key response payload." });
