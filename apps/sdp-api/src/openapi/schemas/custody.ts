import {
  approvalRequestStatusSchema as approvalRequestStatusSchemaBase,
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
    "Switch the active wallet signing target by provider or exact Custody Connection ID for the project resolved from the request context.",
  example: { provider: "privy" },
});

export const signerCheckRequestSchema = withOpenApi(signerCheckSchemaBase, {
  description:
    "Signer-check wallet selection. walletId is optional for an API key with one bound signing wallet and required for session-authenticated dashboard requests.",
  example: { walletId: "privy_wallet_123" },
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
    connectionId: withOpenApi(createWalletSchemaBase.shape.connectionId, {
      description:
        "Optional exact Custody Connection target. When present, it is authoritative and provider is only a consistency assertion.",
    }),
    provider: orgCustodyProviderSchema.optional().openapi({
      description:
        "Optional provider target. With connectionId it must match that Connection; otherwise the effective/provider-only target is resolved for the scope.",
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
  .openapi({
    description: "Create wallet request body.",
    example: {
      provider: "privy",
      label: "Mint authority wallet",
      purpose: "mint_authority",
      setDefault: true,
    },
  });

export const setDefaultWalletRequestSchema = setDefaultWalletSchemaBase
  .extend({
    provider: orgCustodyProviderSchema.optional().openapi({
      description:
        "Optional consistency assertion for the Provider of the wallet resolved by walletId.",
      example: "privy",
    }),
    walletId: walletIdParamSchema.openapi({
      description: "Provider wallet ID to set as the default for its exact owning target.",
      example: "privy_wallet_123",
    }),
  })
  .openapi({ description: "Set default wallet request body." });

export const deleteWalletRequestSchema = deleteWalletSchemaBase
  .extend({
    provider: orgCustodyProviderSchema.optional().openapi({
      description: "Optional consistency assertion for the Provider of the wallet being deleted.",
      example: "anchorage",
    }),
    walletId: walletIdParamSchema.openapi({
      description: "Provider wallet ID to delete from its exact owning target.",
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

export const switchSigningResponseSchema = z
  .union([
    initializeSigningResponseSchema,
    z.object({
      connectionId: z.string().openapi({
        description: "Selected Custody Connection ID.",
        example: "cconn_example",
      }),
      publicKey: solanaAddressSchema.openapi({
        description: "Public key of the Connection's default wallet.",
      }),
      walletId: walletIdParamSchema.openapi({
        description: "Provider wallet ID of the Connection's default wallet.",
        example: "privy_wallet_123",
      }),
    }),
  ])
  .openapi({
    description: "Wallet signing switch result.",
    example: {
      connectionId: "cconn_example",
      publicKey: "So11111111111111111111111111111111111111112",
      walletId: "privy_wallet_123",
    },
  });

const custodyWalletOwnerConstraint = {
  oneOf: [
    {
      required: ["custodyConfigId"],
      not: { required: ["custodyConnectionId"] },
    },
    {
      required: ["custodyConnectionId"],
      not: { required: ["custodyConfigId"] },
    },
  ],
};

const custodyWalletExample = {
  id: "cw_example",
  custodyConfigId: "cfg_example",
  provider: "privy",
  isDefaultProvider: true,
  isRuntimeExecutionAllowed: true,
  walletId: "privy_wallet_123",
  publicKey: "So11111111111111111111111111111111111111112",
  label: "Root Signing Wallet",
  purpose: "root",
  status: "active",
  createdAt: "2025-01-01T00:00:00.000Z",
};

const custodyWalletBaseSchema = z.object({
  id: z.string().openapi({ description: "Wallet record ID.", example: "cw_example" }),
  custodyConfigId: z.string().optional().openapi({
    description: "Owning custody configuration ID.",
    example: "cfg_example",
  }),
  custodyConnectionId: z.string().optional().openapi({
    description: "Owning Custody Connection ID.",
    example: "cconn_example",
  }),
  provider: orgCustodyProviderSchema.optional(),
  isDefaultProvider: z.boolean().optional().openapi({
    description:
      "Whether this wallet's exact Config or Connection owner is the effective custody target for the requested scope.",
    example: true,
  }),
  isRuntimeExecutionAllowed: z.boolean().openapi({
    description:
      "Whether SDP currently permits attempting runtime execution through this wallet's owner. This is request-time admission, not Provider health or a success guarantee.",
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
      description:
        "Tracked token balances when requested and successfully observed. Omitted when the balance lookup is unavailable; an empty array is a successful zero-token result.",
    }),
  })
  .meta(custodyWalletOwnerConstraint)
  .openapi({
    description: "Wallet details.",
    example: custodyWalletExample,
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
          .optional()
          .openapi({
            description:
              "Current SOL balance for the wallet public key. Omitted when includeBalance=false.",
          }),
      })
      .meta(custodyWalletOwnerConstraint)
      .openapi({
        description: "Wallet details with provider and optional SOL balance.",
        example: custodyWalletExample,
      }),
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

const walletOperationStatusSchema = z
  .enum([
    "created",
    "evaluated",
    "pending_approval",
    "executing",
    "completed",
    "failed",
    "canceled",
  ])
  .openapi({ description: "Current wallet operation status.", example: "pending_approval" });

const policyDecisionSchema = z
  .enum([
    "allow",
    "deny",
    "approval_required",
    "provider_approval_required",
    "review",
    "not_evaluated",
  ])
  .openapi({ description: "Policy decision for this operation.", example: "approval_required" });

const walletApprovalRequestSchema = z
  .object({
    id: z.string().openapi({ description: "Approval request ID.", example: "appr_example" }),
    organizationId: z.string().openapi({ description: "Owning organization ID." }),
    projectId: projectIdParamSchema
      .nullable()
      .openapi({ description: "Project scope for this approval request." }),
    walletOperationId: z.string().openapi({ description: "Associated wallet operation ID." }),
    approvalGroupId: z.string().nullable().openapi({
      description: "Approval group used for this request, when configured.",
    }),
    status: withOpenApi(approvalRequestStatusSchemaBase, {
      description: "Approval request status.",
      example: "pending",
    }),
    provider: z.string().nullable().openapi({
      description: "External approval provider, when applicable.",
      example: "fireblocks",
    }),
    providerReference: z.string().nullable().openapi({
      description: "External provider reference, when applicable.",
      example: "fb_tx_123",
    }),
    requestedBy: z.string().nullable().openapi({ description: "Requester user or API key ID." }),
    resolvedBy: z.string().nullable().openapi({ description: "Resolver user or API key ID." }),
    expiresAt: isoDateTimeSchema.nullable(),
    resolvedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    wallet: z
      .object({
        custodyWalletId: z.string().openapi({ description: "Internal custody wallet row ID." }),
        walletId: walletIdParamSchema,
        publicKey: solanaAddressSchema,
        label: z.string().nullable().openapi({ description: "Wallet label." }),
      })
      .nullable()
      .openapi({ description: "Wallet metadata when the custody wallet still exists." }),
    operation: z
      .object({
        id: z.string().openapi({ description: "Wallet operation ID." }),
        custodyWalletId: z.string().nullable().openapi({
          description: "Internal custody wallet row ID used by the operation.",
        }),
        walletId: walletIdParamSchema,
        apiKeyId: z.string().nullable().openapi({ description: "API key that requested it." }),
        source: z.string().openapi({ description: "Operation source.", example: "api" }),
        operationFamily: z.string().openapi({
          description:
            "Normalized wallet operation family. Historical rows may carry retired families.",
          example: "payment",
        }),
        operationType: z.string().openapi({
          description: "Normalized wallet operation type. Historical rows may carry retired types.",
          example: "payment_transfer_execute",
        }),
        asset: z.string().nullable().openapi({ description: "Asset symbol or mint." }),
        amount: z.string().nullable().openapi({ description: "Operation amount." }),
        destination: z.string().nullable().openapi({ description: "Destination or counterparty." }),
        status: walletOperationStatusSchema,
        executionStartedAt: isoDateTimeSchema.nullable().openapi({
          description: "When execution was claimed after approval.",
        }),
        executionCompletedAt: isoDateTimeSchema.nullable().openapi({
          description: "When approved execution reached a terminal state.",
        }),
        executionError: z.string().nullable().openapi({
          description: "Execution failure message when the operation status is failed.",
        }),
        createdAt: isoDateTimeSchema,
        updatedAt: isoDateTimeSchema,
      })
      .openapi({ description: "Wallet operation awaiting approval." }),
    policyEvaluation: z
      .object({
        id: z.string().openapi({ description: "Policy evaluation ID." }),
        decision: policyDecisionSchema,
        reasonCode: z.string().nullable().openapi({
          description: "Stable reason code explaining the decision.",
          example: "wallet_policy_match",
        }),
        reason: z.string().nullable().openapi({ description: "Human-readable reason." }),
        matchedRules: z
          .array(z.record(z.string(), z.unknown()))
          .openapi({ description: "Policy rules that matched this operation." }),
        requiresApproval: z.boolean().openapi({
          description: "Whether the evaluation required approval.",
          example: true,
        }),
        evaluatedAt: isoDateTimeSchema,
      })
      .nullable()
      .openapi({ description: "Latest policy evaluation linked to this approval request." }),
  })
  .openapi({ description: "Wallet approval request summary." });

export const walletApprovalRequestsResponseSchema = z
  .object({
    approvalRequests: z.array(walletApprovalRequestSchema),
  })
  .openapi({ description: "Wallet approval request list response payload." });

export const walletApprovalRequestResponseSchema = z
  .object({
    approvalRequest: walletApprovalRequestSchema,
  })
  .openapi({ description: "Wallet approval request response payload." });

export const signerCheckResponseSchema = z
  .object({
    walletId: walletIdParamSchema.openapi({
      description: "Resolved signing wallet ID.",
      example: "privy_wallet_123",
    }),
    walletAddress: solanaAddressSchema.openapi({
      description: "Resolved signer address used for the memo transaction.",
    }),
    feePayer: solanaAddressSchema.openapi({
      description: "Fee payer address (Kora signer).",
    }),
    memo: z.string().openapi({
      description: "Server-generated memo text submitted on-chain.",
      example: "SDP signer check 123e4567-e89b-42d3-a456-426614174000",
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
