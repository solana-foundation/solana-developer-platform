import {
  FAILURE_CODES,
  MATERIAL_TAGS,
  OP_TYPES,
  OPERATION_STATES,
  RING_SELECTORS,
  RING_STATUSES,
  RUNTIME_HEALTH_STATUSES,
  TRANSFER_MODES,
  WALLET_STATUSES,
  ZONE_KINDS,
} from "@sdp/helius-rings";
import { solanaAddressSchema, z } from "./base";

const runtimeHealthStatusSchema = z.enum(RUNTIME_HEALTH_STATUSES);

export const ringsRuntimeHealthSchema = z
  .object({
    rpc: runtimeHealthStatusSchema,
    prover: runtimeHealthStatusSchema,
    photon: runtimeHealthStatusSchema,
    gateway: runtimeHealthStatusSchema,
    detail: z
      .record(z.string(), z.string())
      .optional()
      .openapi({ description: "Per-component detail for anything not green." }),
  })
  .openapi({ description: "Per-component gateway health board." });

export const ringsWalletSchema = z
  .object({
    id: z.string().openapi({ example: "hrw_01HXYZ" }),
    sdpWalletId: z
      .string()
      .openapi({ description: "SDP custody wallet backing this rings wallet." }),
    name: z.string(),
    shieldedAddress: z
      .string()
      .nullable()
      .openapi({ description: "Null until the gateway provisions the shielded identity." }),
    status: z.enum(WALLET_STATUSES),
    network: z.literal("devnet"),
    syncCursor: z.string().nullable().openapi({ description: "Null before the first sync." }),
    materialTag: z
      .enum(MATERIAL_TAGS)
      .openapi({ description: "Whether the identity holds real key material." }),
  })
  .openapi({ description: "Rings wallet bound to one SDP custody wallet." });

export const ringsProjectRingSchema = z
  .object({
    ringProgramId: solanaAddressSchema,
    status: z
      .enum(RING_STATUSES)
      .openapi({ description: "Bring-up is resumable: re-submit the same id to retry a failure." }),
    auditorPublicKeyHex: z.string().nullable().openapi({
      description:
        "Uncompressed SEC1 P-256 point as hex, as the ring's on-chain config publishes it.",
    }),
    failure: z
      .object({
        code: z.enum([
          "invalid_input",
          "not_found",
          "conflict",
          "gateway_unavailable",
          "config_error",
        ]),
        message: z.string(),
      })
      .nullable()
      .openapi({
        description: "Why the last bring-up attempt failed; null unless status is failed.",
      }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ description: "The project's one custom ring." });

export const ringsAssetBalanceSchema = z
  .object({
    mint: solanaAddressSchema,
    symbol: z.string(),
    amountRaw: z.string().openapi({
      description:
        "Base-unit integer as a decimal string; uint64 on the wire, so never a JSON number.",
    }),
    decimals: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "The mint's scale, or null when unknown." }),
    ringProgramId: solanaAddressSchema.nullable().openapi({
      description:
        "Ring the notes are bound to; null means unbound notes in the default public pool. Balances never merge across rings.",
    }),
  })
  .openapi({ description: "One shielded balance, per mint and ring." });

export const ringsZoneSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(ZONE_KINDS),
  })
  .openapi({ description: "SDP-owned zone metadata." });

export const ringsWalletIdentitySchema = z
  .object({
    status: z.enum(["unregistered", "ours", "foreign"]),
    derivedShieldedAddress: z
      .string()
      .openapi({ description: "Canonical shielded address this tenant derives for the wallet." }),
    publishedShieldedAddress: z
      .string()
      .nullable()
      .openapi({ description: "What the registry publishes; null when unregistered." }),
    mismatch: z
      .enum(["owner", "nullifier_key", "viewing_key"])
      .nullable()
      .openapi({ description: "Which published half differs; null unless status is foreign." }),
    recordedShieldedAddress: z
      .string()
      .nullable()
      .openapi({ description: "The identity SDP's own row records." }),
  })
  .openapi({ description: "Registry identity next to what this tenant derives." });

export const ringsSyncResultSchema = z
  .object({
    balances: z.array(ringsAssetBalanceSchema),
    degraded: z.boolean().openapi({
      description: "True when the sync could not read everything; balances are partial.",
    }),
    observedAt: z.string().openapi({ description: "When the answer was true." }),
  })
  .openapi({ description: "Shielded balances as Photon reports them." });

export const ringsOperationSummarySchema = z
  .object({
    id: z.string().openapi({ example: "hro_01HXYZ" }),
    opType: z.enum(OP_TYPES),
    state: z.enum(OPERATION_STATES),
    assetMint: solanaAddressSchema.nullable(),
    amountRaw: z.string().nullable(),
    ringProgramId: solanaAddressSchema.nullable().openapi({
      description: "Ring the operation targets, pinned at prepare; null = default ring.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ description: "List-shaped operation projection." });

const ringsOperationEventSchema = z
  .object({
    kind: z.string(),
    createdAt: z.string(),
    payload: z.unknown().optional().openapi({ description: "Redacted event payload." }),
  })
  .openapi({ description: "One operation timeline event." });

export const ringsOperationSchema = z
  .object({
    id: z.string().openapi({ example: "hro_01HXYZ" }),
    walletId: z.string(),
    opType: z.enum(OP_TYPES),
    state: z.enum(OPERATION_STATES),
    approvalRequestId: z.string().nullable(),
    policyEvaluationId: z.string().nullable(),
    proof: z
      .null()
      .openapi({ description: "Proof material never leaves the server; always null." }),
    outerTxSignature: z.string().nullable(),
    photonIndexedAt: z.string().nullable(),
    failure: z
      .object({
        code: z.enum(FAILURE_CODES),
        message: z.string(),
        retryable: z.boolean(),
      })
      .nullable(),
    ringProgramId: solanaAddressSchema.nullable().openapi({
      description:
        "Resolved at prepare time and pinned for the operation's whole life; null = default ring.",
    }),
    input: z
      .object({
        walletId: z.string(),
        opType: z.enum(OP_TYPES),
        asset: z.object({ mint: solanaAddressSchema, amountRaw: z.string() }).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        zoneId: z.string().optional(),
        transferMode: z.enum(TRANSFER_MODES).optional(),
        clientNonce: z.string().openapi({
          description: "Consumed by the intent key at reservation, not retained; echoed empty.",
        }),
      })
      .openapi({
        description:
          "Echo of the prepared input. The symbolic ring selector is consumed at prepare; the resolved ringProgramId above is the echo.",
      }),
    intentKey: z.string().openapi({ example: "sha256:9f1c..." }),
    events: z.array(ringsOperationEventSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ description: "Full operation with its event timeline." });

export const createRingsWalletBodySchema = z
  .object({
    walletId: z
      .string()
      .min(1)
      .openapi({ description: "SDP custody wallet id (walletId from GET /v1/wallets)." }),
    name: z.string().min(1).max(120),
  })
  .openapi({ description: "Bind a rings wallet to an SDP custody wallet." });

export const createRingsProjectRingBodySchema = z
  .object({
    ringProgramId: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      .openapi({ description: "Base58 program id of the pre-deployed custom ring program." }),
  })
  .openapi({ description: "Record the project's custom ring and run bring-up." });

export const prepareRingsOperationBodySchema = z
  .object({
    walletId: z.string().min(1).openapi({ description: "Rings wallet id." }),
    opType: z.enum(OP_TYPES),
    asset: z
      .object({
        mint: z.string().min(1),
        amountRaw: z
          .string()
          .regex(/^\d+$/)
          .openapi({ description: "Base-unit integer as a decimal string." }),
      })
      .optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    zoneId: z.string().min(1).optional(),
    transferMode: z.enum(TRANSFER_MODES).optional(),
    ring: z.enum(RING_SELECTORS).optional().openapi({
      description:
        "Symbolic on purpose: the server resolves and pins the program id at prepare time. Defaults to the public ring.",
    }),
    timelock: z
      .object({
        unlockAt: z.string().datetime(),
        beneficiary: z.string().min(1),
      })
      .optional(),
    clientNonce: z.string().min(1).max(128).openapi({
      description: "Caller-supplied; contributes to the intent key so retries are explicit.",
    }),
  })
  .openapi({ description: "Prepare request. Reserves the intent and advances through policy." });

export const retryRingsOperationBodySchema = z
  .object({
    clientNonce: z.string().min(1).max(128).openapi({
      description: "A new nonce for the linked retry; reusing the failed one returns it unchanged.",
    }),
  })
  .openapi({ description: "Retry request body." });

export const createRingsZoneBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.enum(ZONE_KINDS),
  })
  .openapi({ description: "Create-zone request body. Idempotent per (wallet, name)." });

export const ringsWalletIdParamSchema = z.object({
  walletId: z
    .string()
    .min(1)
    .openapi({
      param: { name: "walletId", in: "path" },
      description: "Rings wallet id.",
      example: "hrw_01HXYZ",
    }),
});

export const ringsOperationIdParamSchema = z.object({
  operationId: z
    .string()
    .min(1)
    .openapi({
      param: { name: "operationId", in: "path" },
      description: "Rings operation id.",
      example: "hro_01HXYZ",
    }),
});

export const ringsListLimitQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: "limit", in: "query" },
      description: "Maximum rows to return (1-200).",
    }),
});
