import { PERMISSIONS } from "@sdp/types";
import { z } from "zod";

const apiKeyWalletBindingSchema = z.object({
  walletId: z.string().min(1),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
});

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  role: z.enum(["api_admin", "api_developer", "api_readonly"]).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  walletScope: z.enum(["all", "selected"]),
  allowedIps: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
  signingWalletId: z.string().min(1).optional(),
  signingWalletIds: z.array(z.string().min(1)).optional(),
  walletBindings: z.array(apiKeyWalletBindingSchema).optional(),
  provisionWallet: z.boolean().optional(),
  walletLabel: z.string().max(100).optional(),
  walletPurpose: z
    .enum(["root", "mint_authority", "freeze_authority", "fee_payer", "transfer"])
    .optional(),
});

export const apiKeyUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  walletScope: z.enum(["all", "selected"]).optional(),
  allowedIps: z.array(z.string()).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  permissions: z.array(z.enum(PERMISSIONS)).nullable().optional(),
  signingWalletId: z.string().min(1).nullable().optional(),
  signingWalletIds: z.array(z.string().min(1)).nullable().optional(),
  walletBindings: z.array(apiKeyWalletBindingSchema).nullable().optional(),
});

export const apiKeyRotateSchema = z.object({
  gracePeriodHours: z.number().min(0).max(168).optional(), // Max 7 days
});
