import {
  FAILURE_CODES,
  MATERIAL_TAGS,
  RING_STATUSES,
  RUNTIME_HEALTH_STATUSES,
  TRANSFER_MODES,
  WALLET_STATUSES,
  ZONE_KINDS,
} from "@sdp/helius-rings/constants";
import type {
  AssetBalance,
  PrivateOperation,
  PrivateOperationInput,
  PrivateOperationSummary,
  PrivateWallet,
  ProjectRing,
  RuntimeHealth,
  Zone,
} from "@sdp/helius-rings/types";
import {
  HELIUS_RINGS_CONNECTION_STATUSES,
  HELIUS_RINGS_OPERATION_STATUSES,
  HELIUS_RINGS_OPERATION_TYPES,
} from "@sdp/types/helius-rings";
import { z } from "zod";
import type { SafeRingsConnection } from "@/services/helius-rings/connection.service";
import type { WalletIdentityResult } from "@/services/helius-rings/service";

export const ringsHealthSchema = z.object({
  rpc: z.enum(RUNTIME_HEALTH_STATUSES),
  prover: z.enum(RUNTIME_HEALTH_STATUSES),
  photon: z.enum(RUNTIME_HEALTH_STATUSES),
  detail: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<RuntimeHealth>;
// Connection display metadata comes from URL.origin; keyed paths and queries
// are never part of the safe DTO.
const ringsEndpointOriginSchema = z.url().regex(/^https?:\/\/[^/?#@\s]+$/);
export const ringsConnectionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  network: z.literal("devnet"),
  status: z.enum(HELIUS_RINGS_CONNECTION_STATUSES),
  isDefault: z.boolean(),
  allowInsecureHttp: z.boolean(),
  endpoints: z.strictObject({
    rpc: ringsEndpointOriginSchema.nullable(),
    indexer: ringsEndpointOriginSchema.nullable(),
    prover: ringsEndpointOriginSchema.nullable(),
    ringRpc: ringsEndpointOriginSchema.nullable(),
  }),
  lastCheckStatus: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
  lastCheckFailureCode: z.string().nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<SafeRingsConnection>;
export const ringsSetupSchema = z.discriminatedUnion("configured", [
  z.object({
    configured: z.literal(true),
    source: z.literal("database"),
    canManage: z.boolean(),
    allowInsecureHttpAllowed: z.boolean(),
    defaultConnection: ringsConnectionSchema,
  }),
  z.object({
    configured: z.literal(false),
    source: z.literal("none"),
    canManage: z.boolean(),
    allowInsecureHttpAllowed: z.boolean(),
    defaultConnection: z.null().openapi({ enum: [null] }),
  }),
]);
export const ringsConnectionTestSchema = z.strictObject({
  health: ringsHealthSchema.strict(),
  ringRpc: z
    .strictObject({ status: z.enum(RUNTIME_HEALTH_STATUSES), reason: z.string().optional() })
    .nullable(),
});
export const ringsWalletSchema = z.object({
  id: z.string(),
  sdpWalletId: z.string(),
  name: z.string(),
  shieldedAddress: z.string().nullable(),
  status: z.enum(WALLET_STATUSES),
  network: z.literal("devnet"),
  syncCursor: z.string().nullable(),
  materialTag: z.enum(MATERIAL_TAGS),
}) satisfies z.ZodType<PrivateWallet>;
export const ringsIdentitySchema = z.object({
  status: z.enum(["unregistered", "ours", "foreign"]),
  derivedShieldedAddress: z.string(),
  publishedShieldedAddress: z.string().nullable(),
  mismatch: z.enum(["owner", "nullifier_key", "viewing_key"]).nullable(),
  recordedShieldedAddress: z.string().nullable(),
}) satisfies z.ZodType<WalletIdentityResult>;
const balance = z.object({
  mint: z.string(),
  symbol: z.string(),
  amountRaw: z.string(),
  decimals: z.number().nullable(),
  ringProgramId: z.string().nullable(),
  noteCount: z.number(),
}) satisfies z.ZodType<AssetBalance>;
export const ringsSyncSchema = z.object({
  balances: z.array(
    balance.extend({ usdPrice: z.number().optional(), usdValue: z.number().optional() })
  ),
  totalUsd: z.number().nullable(),
  degraded: z.boolean(),
  observedAt: z.string(),
});
export const ringsZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ZONE_KINDS),
}) satisfies z.ZodType<Zone>;
export const projectRingSchema = z.object({
  id: z.string(),
  name: z.string(),
  ringProgramId: z.string(),
  status: z.enum(RING_STATUSES),
  auditorPublicKeyHex: z.string().nullable(),
  lookupTableAddress: z.string().nullable(),
  failure: z
    .object({
      code: z.enum([
        "invalid_input",
        "not_found",
        "conflict",
        "gateway_unavailable",
        "config_error",
        "insufficient_balance",
        "provider_unsupported",
        "manual_reconciliation_required",
      ]),
      message: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ProjectRing>;
// Historical rows include retired flows and omit fields absent at intent time.
// The consumed clientNonce is returned as an empty string, never reconstructed.
const recordedInput = z.object({
  walletId: z.string(),
  opType: z.enum(HELIUS_RINGS_OPERATION_TYPES),
  clientNonce: z.string(),
  asset: z.object({ mint: z.string(), amountRaw: z.string().optional() }).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  zoneId: z.string().optional(),
  transferMode: z.enum(TRANSFER_MODES).optional(),
  timelock: z.object({ unlockAt: z.string(), beneficiary: z.string() }).optional(),
  ring: z.string().optional(),
}) satisfies z.ZodType<PrivateOperationInput>;
export const ringsOperationSchema = z.object({
  id: z.string(),
  walletId: z.string(),
  opType: z.enum(HELIUS_RINGS_OPERATION_TYPES),
  state: z.enum(HELIUS_RINGS_OPERATION_STATUSES),
  // The service's API mapper always strips proof artifacts from its DTO.
  proof: z.null().openapi({ enum: [null] }),
  outerTxSignature: z.string().nullable(),
  photonIndexedAt: z.string().nullable(),
  failure: z
    .object({ code: z.enum(FAILURE_CODES), message: z.string(), retryable: z.boolean() })
    .nullable(),
  ringProgramId: z.string().nullable(),
  input: recordedInput,
  intentKey: z.string(),
  events: z.array(
    z.object({ kind: z.string(), createdAt: z.string(), payload: z.unknown().optional() })
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
  retryOfOperationId: z.string().nullable(),
}) satisfies z.ZodType<PrivateOperation>;
export const ringsOperationSummarySchema = z.object({
  id: z.string(),
  walletId: z.string(),
  opType: z.enum(HELIUS_RINGS_OPERATION_TYPES),
  state: z.enum(HELIUS_RINGS_OPERATION_STATUSES),
  assetMint: z.string().nullable(),
  amountRaw: z.string().nullable(),
  ringProgramId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  failureCode: z.enum(FAILURE_CODES).nullable(),
  outerTxSignature: z.string().nullable(),
  retryable: z.boolean().nullable(),
  retryOfOperationId: z.string().nullable(),
}) satisfies z.ZodType<PrivateOperationSummary>;
