import { OP_TYPES, TRANSFER_MODES, ZONE_KINDS } from "@sdp/helius-rings";
import { z } from "zod";

export const createRingsWalletSchema = z.object({
  /** SDP custody wallet id (`walletId` from GET /v1/wallets). */
  walletId: z.string().min(1),
  name: z.string().min(1).max(120),
});

export const prepareRingsOperationSchema = z.object({
  walletId: z.string().min(1),
  opType: z.enum(OP_TYPES),
  asset: z
    .object({
      mint: z.string().min(1),
      amountRaw: z.string().regex(/^\d+$/, "amountRaw must be a base-unit integer string"),
    })
    .optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  zoneId: z.string().min(1).optional(),
  transferMode: z.enum(TRANSFER_MODES).optional(),
  timelock: z
    .object({
      unlockAt: z.iso.datetime(),
      beneficiary: z.string().min(1),
    })
    .optional(),
  /** Caller-supplied; contributes to the intent key so retries are explicit. */
  clientNonce: z.string().min(1).max(128),
});

export const retryRingsOperationSchema = z.object({
  clientNonce: z.string().min(1).max(128),
});

export const createRingsZoneSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(ZONE_KINDS),
});

export const listLimitSchema = z.coerce.number().int().min(1).max(200).optional();
