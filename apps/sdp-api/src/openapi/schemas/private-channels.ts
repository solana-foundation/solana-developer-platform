import {
  PRIVATE_CHANNEL_EVENT_FAMILY_VALUES,
  PRIVATE_CHANNEL_EVENT_STATUS_VALUES,
  PRIVATE_CHANNEL_EVENT_TYPE_VALUES,
  PRIVATE_CHANNEL_EVENT_TYPES,
} from "@sdp/types";
import { privateChannelTransferAmountSchema } from "@/lib/private-channel-transfer-amount";
import { solanaAddressSchema, withOpenApi, z } from "./base";

export const privateChannelInstanceSchema = z
  .object({
    id: z.string().openapi({ example: "pci_01HXYZ" }),
    organizationId: z.string(),
    projectId: z.string(),
    gatewayUrl: z.string().openapi({ example: "http://34.71.147.163:8899" }),
    chainRpcUrl: z.string().openapi({ example: "https://devnet.helius-rpc.com/?api-key=…" }),
    escrowProgramId: solanaAddressSchema,
    withdrawProgramId: solanaAddressSchema,
    escrowInstanceAddr: solanaAddressSchema,
    authUrl: z.string().openapi({ description: "Base URL of the SPC auth service." }),
    isActive: z.boolean().openapi({ description: "True for the active instance." }),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ description: "Persisted Private Channels instance." });

export const privateChannelInstanceInputSchema = z
  .object({
    gatewayUrl: z.string(),
    chainRpcUrl: z.string(),
    escrowProgramId: solanaAddressSchema,
    withdrawProgramId: solanaAddressSchema,
    escrowInstanceAddr: solanaAddressSchema,
    authUrl: z.string(),
    confirmReactivate: z.boolean().optional().openapi({
      description:
        "Required (true) to reactivate an inactive same-gateway row and overwrite its config.",
    }),
  })
  .openapi({ description: "Connect request body." });

export const privateChannelHealthSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("ready"), latencyMs: z.number() }),
    z.object({ status: z.literal("degraded"), latencyMs: z.number(), reason: z.string() }),
    z.object({ status: z.literal("unreachable"), latencyMs: z.number(), error: z.string() }),
  ])
  .openapi({ description: "Candidate-gateway health probe result." });

export const privateChannelHealthQuerySchema = z.object({
  gatewayUrl: z
    .string()
    .min(1)
    .openapi({
      param: { name: "gatewayUrl", in: "query" },
      description: "Candidate SPC gateway base URL to probe.",
      example: "http://34.71.147.163:8899",
    }),
});

export const privateChannelProbeBodySchema = z
  .object({
    gatewayUrl: z.string().min(1),
    chainRpcUrl: z.string().min(1),
    authUrl: z.string().min(1),
  })
  .openapi({ description: "Probe request body: the three URLs the connect flow re-probes." });

const gatewayProbeResponseSchema = z.object({
  status: z.number(),
  ok: z.boolean(),
  body: z.unknown().optional(),
});

export const privateChannelOverviewSchema = z
  .object({
    gateway: z.object({
      health: z.discriminatedUnion("status", [
        z.object({ status: z.literal("ready"), latencyMs: z.number() }),
        z.object({ status: z.literal("degraded"), latencyMs: z.number(), reason: z.string() }),
        z.object({ status: z.literal("unreachable"), latencyMs: z.number(), error: z.string() }),
      ]),
      channelSlot: z.number().nullable(),
      latestBlockhash: z.string().nullable(),
    }),
    chainRpc: z.union([
      z.object({ ok: z.literal(true), solanaVersion: z.string().nullable() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    escrowInstance: z.union([
      z.object({
        present: z.literal(true),
        owner: z.string(),
        ownerMatchesProgram: z.boolean(),
        lamports: z.number(),
      }),
      z.object({ present: z.literal(false), error: z.string() }),
    ]),
    escrowProgram: z.union([
      z.object({ present: z.literal(true), executable: z.boolean() }),
      z.object({ present: z.literal(false), error: z.string() }),
    ]),
    auth: z.object({ reachable: z.boolean(), error: z.string().nullable() }),
  })
  .openapi({ description: "Post-connect instance overview." });

export const privateChannelProbeResultSchema = z
  .object({
    ok: z.boolean(),
    gateway: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("ready"),
        latencyMs: z.number(),
        health: gatewayProbeResponseSchema,
        ready: gatewayProbeResponseSchema,
      }),
      z.object({
        status: z.literal("degraded"),
        latencyMs: z.number(),
        health: gatewayProbeResponseSchema,
        ready: gatewayProbeResponseSchema,
        reason: z.string(),
      }),
      z.object({
        status: z.literal("unreachable"),
        latencyMs: z.number(),
        error: z.string(),
        health: gatewayProbeResponseSchema.optional(),
        ready: gatewayProbeResponseSchema.optional(),
      }),
    ]),
    rpc: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), latencyMs: z.number(), version: z.string() }),
      z.object({ ok: z.literal(false), latencyMs: z.number(), error: z.string() }),
    ]),
    auth: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), latencyMs: z.number() }),
      z.object({ ok: z.literal(false), latencyMs: z.number(), error: z.string() }),
    ]),
  })
  .openapi({ description: "Full connect-time probe result (gateway + chain RPC + auth)." });

export const privateChannelSchema = z
  .object({
    id: z.string().openapi({ example: "pch_9f1c..." }),
    name: z.string().openapi({ example: "Treasury" }),
    description: z.string().nullable().openapi({ example: "Ops payouts" }),
    isDefault: z.boolean().openapi({
      description: "The connected instance's auto-provisioned default channel.",
      example: false,
    }),
    status: z
      .enum(["active", "archived"])
      .openapi({ description: "Soft-delete lifecycle status.", example: "active" }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ description: "A logical channel." });

export const privateChannelListSchema = z.object({
  channels: z.array(privateChannelSchema),
});

export const createPrivateChannelBodySchema = z
  .object({
    name: z.string().min(1).max(64).openapi({ example: "Treasury" }),
    description: z.string().optional().openapi({ example: "Ops payouts" }),
  })
  .openapi({ description: "Create a named private channel." });

export const privateChannelIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description: "Private channel id.",
      example: "pch_9f1c...",
    }),
});

export const privateChannelBalanceQuerySchema = z.object({
  owner: z
    .string()
    .min(1)
    .openapi({
      param: { name: "owner", in: "query" },
      description:
        "Owner to read the balance for: a `walletId` from GET /v1/wallets, a wallet public key, or a raw Solana address.",
      example: "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz",
    }),
  mint: solanaAddressSchema.optional().openapi({
    param: { name: "mint", in: "query" },
    description:
      "Token mint to read. Any mint is accepted here — this is a general read. Defaults to the instance's first allowed token.",
  }),
});

export const privateChannelBalanceSchema = z
  .object({
    owner: solanaAddressSchema,
    mint: solanaAddressSchema,
    tokenAccount: solanaAddressSchema.openapi({
      description: "The classic-Token associated-token account probed on the channel.",
    }),
    amount: z.string().openapi({ description: "Raw base-unit amount.", example: "1500000" }),
    decimals: z.number().openapi({ example: 6 }),
    uiAmount: z.string().openapi({ description: "Human-readable amount.", example: "1.5" }),
  })
  .openapi({
    description:
      "An owner's channel token balance (per wallet+mint, via the gateway). Shared across the wallet's channels.",
  });

export const privateChannelDepositSchema = z
  .object({
    id: z.string().openapi({ example: "dep_9f1c..." }),
    instanceId: z.string(),
    organizationId: z.string(),
    projectId: z.string(),
    walletId: z.string().openapi({ description: "Custody wallet the deposit is signed from." }),
    depositor: solanaAddressSchema,
    recipient: solanaAddressSchema.openapi({
      description: "Address credited in the channel (defaults to the depositor).",
    }),
    mint: solanaAddressSchema,
    amount: z.string().openapi({ description: "Decimal amount.", example: "1.5" }),
    status: z
      .enum(["pending", "submitted", "confirmed", "settled", "failed"])
      .openapi({ description: "Transfer lifecycle status.", example: "confirmed" }),
    signature: z
      .string()
      .nullable()
      .openapi({ description: "Devnet escrow tx signature (null until submitted)." }),
    settlementRef: z.string().nullable().openapi({
      description:
        "Settlement correlation, populated when status is settled. Chain oracle cannot reach this for deposits; set by the future SPC event source.",
    }),
    failureReason: z.string().nullable().openapi({ description: "Set when status is failed." }),
    context: z.record(z.string(), z.unknown()).openapi({
      description:
        "Audit snapshot of the SPC instance parameters at intent time. Secrets redacted.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ description: "A Private Channels deposit intent." });

export const privateChannelDepositListSchema = z.object({
  deposits: z.array(privateChannelDepositSchema),
});

export const createPrivateChannelDepositBodySchema = z
  .object({
    walletId: z.string().min(1).openapi({
      description: "Source custody wallet (walletId or public key).",
      example: "wlt_…",
    }),
    amount: withOpenApi(privateChannelTransferAmountSchema, {
      description: "Positive decimal amount with at most six fractional digits.",
      example: "1.5",
    }),
    mint: solanaAddressSchema.optional().openapi({
      description:
        "Token mint to deposit. Must be one this instance allows; any other mint is rejected with 400. Defaults to the instance's first allowed token.",
    }),
    recipient: z.string().min(1).optional().openapi({
      description: "Address/walletId to credit in the channel. Defaults to the depositor.",
    }),
  })
  .openapi({ description: "Create a deposit into the channel escrow." });

export const privateChannelDepositIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description: "Deposit id.",
      example: "dep_9f1c...",
    }),
});

export const privateChannelVerifiedWalletSchema = z
  .object({
    id: z.string().openapi({ example: "pcvw_9f1c..." }),
    walletId: z
      .string()
      .openapi({ description: "SDP managed custody wallet id.", example: "wallet_123" }),
    pubkey: solanaAddressSchema,
    verifiedAt: z.string(),
  })
  .openapi({ description: "A custody wallet verified with the connected SPC instance." });

export const privateChannelVerifiedWalletListSchema = z.object({
  wallets: z.array(privateChannelVerifiedWalletSchema),
});

export const privateChannelVerifyWalletParamSchema = z.object({
  walletId: z
    .string()
    .min(1)
    .openapi({
      param: { name: "walletId", in: "path" },
      description: "SDP managed custody wallet id to verify.",
      example: "wallet_123",
    }),
});

export const privateChannelDeleteWalletParamSchema = z.object({
  pubkey: z
    .string()
    .min(1)
    .openapi({
      param: { name: "pubkey", in: "path" },
      description: "Verified wallet pubkey (base58) to revoke.",
      example: "7C1Pu8...",
    }),
});

export const privateChannelWithdrawalSchema = z
  .object({
    id: z.string().openapi({ example: "wd_9f1c..." }),
    instanceId: z.string(),
    organizationId: z.string(),
    projectId: z.string(),
    walletId: z
      .string()
      .openapi({ description: "Custody wallet whose channel-chain balance is burned." }),
    owner: solanaAddressSchema.openapi({
      description: "Channel-chain address whose token balance is burned.",
    }),
    destination: solanaAddressSchema.openapi({
      description: "Devnet address that receives the operator's release (defaults to the owner).",
    }),
    mint: solanaAddressSchema,
    amount: z.string().openapi({ description: "Decimal amount.", example: "1.5" }),
    status: z
      .enum(["pending", "submitted", "confirmed", "settled", "failed"])
      .openapi({ description: "Transfer lifecycle status.", example: "confirmed" }),
    signature: z
      .string()
      .nullable()
      .openapi({ description: "Channel-chain burn signature (null until submitted)." }),
    settlementRef: z.string().nullable().openapi({
      description: "Devnet release signature — settlement correlation (null until settled).",
    }),
    failureReason: z.string().nullable().openapi({ description: "Set when status is failed." }),
    context: z.record(z.string(), z.unknown()).openapi({
      description:
        "Audit snapshot of the SPC instance parameters at intent time. Secrets redacted.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ description: "A Private Channels withdrawal intent." });

export const privateChannelWithdrawalListSchema = z.object({
  withdrawals: z.array(privateChannelWithdrawalSchema),
});

export const createPrivateChannelWithdrawalBodySchema = z
  .object({
    walletId: z.string().min(1).openapi({
      description: "Custody wallet to burn from (walletId or public key).",
      example: "wlt_…",
    }),
    amount: withOpenApi(privateChannelTransferAmountSchema, {
      description: "Positive decimal amount with at most six fractional digits.",
      example: "1.5",
    }),
    mint: solanaAddressSchema.optional().openapi({
      description:
        "Token mint to withdraw. Must be one this instance allows; any other mint is rejected with 400. Defaults to the instance's first allowed token.",
    }),
    destination: z.string().min(1).optional().openapi({
      description: "Devnet address/walletId to release to. Defaults to the owner wallet.",
    }),
  })
  .openapi({ description: "Create a withdrawal from the channel balance." });

export const privateChannelWithdrawalIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description: "Withdrawal id.",
      example: "wd_9f1c...",
    }),
});

export const privateChannelTransferSchema = z
  .object({
    id: z.string().openapi({ example: "pct_9f1c..." }),
    organizationId: z.string(),
    projectId: z.string(),
    instanceId: z.string(),
    channelId: z.string(),
    walletId: z.string().openapi({ description: "Custody wallet used to sign the transfer." }),
    sender: solanaAddressSchema,
    recipient: solanaAddressSchema,
    mint: solanaAddressSchema,
    amount: z.string().openapi({ description: "Decimal amount.", example: "1.5" }),
    status: z.enum(["pending", "submitted", "confirmed", "failed"]).openapi({
      description:
        "Transfer lifecycle. `pending` is written before broadcast. `submitted` means SPC accepted the transaction at ingress, which is not yet execution. `confirmed` means SPC executed it and is terminal — SPC runs a single sequencer with no fork choice, so one status read is final. `failed` covers preparation errors, ingress rejection and execution errors. A transfer left at `submitted` means the confirm read returned no verdict.",
      example: "confirmed",
    }),
    signature: z
      .string()
      .nullable()
      .openapi({ description: "SPC signature. Set once the transfer is submitted." }),
    failureReason: z.string().nullable().openapi({ description: "Set when status is failed." }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ description: "A transfer between verified wallets of channel members." });

export const privateChannelTransferListSchema = z.object({
  transfers: z.array(privateChannelTransferSchema),
});

const privateChannelTransferRecipientWalletSchema = z.object({
  id: z.string().openapi({ description: "Opaque verified-wallet id." }),
  pubkey: solanaAddressSchema,
});

const privateChannelTransferRecipientSchema = z.object({
  privateChannelUserId: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  wallets: z.array(privateChannelTransferRecipientWalletSchema),
});

export const privateChannelTransferRecipientListSchema = z.object({
  recipients: z.array(privateChannelTransferRecipientSchema),
});

export const createPrivateChannelTransferBodySchema = z
  .object({
    walletId: z.string().min(1).openapi({
      description: "Verified SDP custody wallet controlled by the acting member.",
      example: "wallet_123",
    }),
    recipientVerifiedWalletId: z.string().min(1).openapi({
      description:
        "Opaque id returned by the channel's transfer-recipients endpoint; arbitrary addresses are not accepted.",
      example: "pcvw_9f1c...",
    }),
    amount: withOpenApi(privateChannelTransferAmountSchema, {
      description: "Positive decimal amount with at most six fractional digits.",
      example: "1.5",
    }),
    mint: solanaAddressSchema.optional().openapi({
      description:
        "Token mint to transfer. Must be one this instance allows; any other mint is rejected with 400. Defaults to the instance's first allowed token.",
    }),
  })
  .openapi({ description: "Create a verified member-to-member channel transfer." });

export const privateChannelTransferChannelIdParamSchema = z.object({
  channelId: z
    .string()
    .min(1)
    .openapi({
      param: { name: "channelId", in: "path" },
      description: "Active logical channel id.",
      example: "pch_9f1c...",
    }),
});

export const privateChannelTransferIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: "id", in: "path" },
      description: "Private-channel transfer id.",
      example: "pct_9f1c...",
    }),
});

export const privateChannelTransferListQuerySchema = z.object({
  channelId: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "channelId", in: "query" },
      description: "Optionally filter project transfer history by logical channel id.",
    }),
});

export const privateChannelEventFamilySchema = z.enum(PRIVATE_CHANNEL_EVENT_FAMILY_VALUES);

export const privateChannelEventStatusSchema = z.enum(PRIVATE_CHANNEL_EVENT_STATUS_VALUES);

export const privateChannelEventTypeSchema = z
  .enum(PRIVATE_CHANNEL_EVENT_TYPE_VALUES)
  .openapi({ example: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED });

export const privateChannelEventSchema = z
  .object({
    id: z.string().openapi({ example: "pce_9f1c..." }),
    organizationId: z.string(),
    projectId: z.string(),
    instanceId: z.string(),
    channelId: z.string().nullable(),
    sdpUserId: z.string().nullable(),
    family: privateChannelEventFamilySchema,
    type: privateChannelEventTypeSchema,
    status: privateChannelEventStatusSchema,
    payload: z.record(z.string(), z.unknown()),
    occurredAt: z.string(),
    createdAt: z.string(),
  })
  .openapi({ description: "A Private Channels activity event." });

export const privateChannelEventListSchema = z.object({
  events: z.array(privateChannelEventSchema),
  hasMore: z.boolean(),
  nextCursor: z
    .string()
    .nullable()
    .openapi({ description: "Opaque cursor for the next page; null when there are no more." }),
});

export const privateChannelEventsQuerySchema = z.object({
  family: privateChannelEventFamilySchema.optional().openapi({
    param: { name: "family", in: "query" },
    description: "Filter by event family.",
  }),
  type: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "type", in: "query" },
      description: `Exact event type match (e.g. ${PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED}).`,
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .openapi({
      param: { name: "limit", in: "query" },
      description: "Page size (default 50, max 100).",
    }),
  before: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "before", in: "query" },
      description: "Opaque pagination cursor from a previous response's nextCursor.",
    }),
});
