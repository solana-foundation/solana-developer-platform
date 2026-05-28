/**
 * Wallet API Schemas
 */

import type {
  CustodyConfigResponse,
  CustodyConfigsResponse,
  CustodyWalletAggregateResponse,
  CustodyWalletByIdResponse,
  CustodyWalletResponse,
  CustodyWalletsResponse,
  DeleteWalletResponse,
  InitializeSigningResponse,
  SignerCheckResponse,
  SwitchProviderOptionsResponse,
} from "@sdp/types";
import { z } from "zod";
import { CUSTODY_PROVIDERS } from "@/services/custody/providers";

const custodyProviderSchema = z.enum(CUSTODY_PROVIDERS);

// ═══════════════════════════════════════════════════════════════════════════
// Initialize Signing
// ═══════════════════════════════════════════════════════════════════════════

export const initializeLocalSchema = z.object({
  provider: z.literal("local"),
  walletLabel: z.string().max(100).optional(),
});

export const initializeFireblocksSchema = z.object({
  provider: z.literal("fireblocks"),
  walletLabel: z.string().max(100).optional(),
});

export const initializePrivySchema = z.object({
  provider: z.literal("privy"),
  apiBaseUrl: z.string().url().optional(),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeCoinbaseCdpSchema = z.object({
  provider: z.literal("coinbase_cdp"),
  apiBaseUrl: z.string().url().optional(),
  network: z.enum(["solana", "solana-devnet"]).optional(),
  walletAddress: z.string().min(32).max(44).optional(),
  accountPolicy: z
    .string()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
    .optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeParaSchema = z.object({
  provider: z.literal("para"),
  apiBaseUrl: z.string().url().optional(),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletId: z.string().min(1).optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeTurnkeySchema = z.object({
  provider: z.literal("turnkey"),
  apiBaseUrl: z.string().url().optional(),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  privateKeyId: z.string().min(1).optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeDfnsSchema = z.object({
  provider: z.literal("dfns"),
  apiBaseUrl: z.string().url().optional(),
  network: z.enum(["Solana", "SolanaDevnet"]).optional(),
  walletId: z.string().min(1).optional(),
  signingKeyId: z.string().min(1).optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeAnchorageSchema = z.object({
  provider: z.literal("anchorage"),
  apiBaseUrl: z.string().url().optional(),
  walletId: z.string().min(1).optional(),
  walletLabel: z.string().max(100).optional(),
  network: z.enum(["solana", "solana-devnet"]).optional(),
});

export const initializeSigningSchema = z.discriminatedUnion("provider", [
  initializeLocalSchema,
  initializeFireblocksSchema,
  initializePrivySchema,
  initializeCoinbaseCdpSchema,
  initializeParaSchema,
  initializeTurnkeySchema,
  initializeDfnsSchema,
  initializeAnchorageSchema,
]);

export type InitializeSigningRequest = z.infer<typeof initializeSigningSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Create Wallet
// ═══════════════════════════════════════════════════════════════════════════

export const createWalletSchema = z.object({
  provider: custodyProviderSchema.optional(),
  label: z.string().max(100).optional(),
  purpose: z
    .enum(["root", "mint_authority", "freeze_authority", "fee_payer", "transfer"])
    .optional(),
  setDefault: z.boolean().optional(),
});

export type CreateWalletRequest = z.infer<typeof createWalletSchema>;

export const updateWalletSchema = z.object({
  label: z.string().max(100).nullable().optional(),
});

export type UpdateWalletRequest = z.infer<typeof updateWalletSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Switch Signing Provider
// ═══════════════════════════════════════════════════════════════════════════

export const switchSigningSchema = z.discriminatedUnion("provider", [
  initializeLocalSchema,
  initializeFireblocksSchema,
  initializePrivySchema,
  initializeCoinbaseCdpSchema,
  initializeParaSchema,
  initializeTurnkeySchema,
  initializeDfnsSchema,
  initializeAnchorageSchema,
]);

export type SwitchSigningRequest = z.infer<typeof switchSigningSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Set Default Wallet
// ═══════════════════════════════════════════════════════════════════════════

export const setDefaultWalletSchema = z.object({
  provider: custodyProviderSchema.optional(),
  walletId: z.string().min(1),
});

export type SetDefaultWalletRequest = z.infer<typeof setDefaultWalletSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Delete Wallet
// ═══════════════════════════════════════════════════════════════════════════

export const deleteWalletSchema = z.object({
  provider: custodyProviderSchema.optional(),
  walletId: z.string().min(1),
});

export type DeleteWalletRequest = z.infer<typeof deleteWalletSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Signer Check (API key flow)
// ═══════════════════════════════════════════════════════════════════════════

export const signerCheckSchema = z.object({
  memo: z.string().max(256).optional(),
  walletId: z.string().min(1).optional(),
});

export type SignerCheckRequest = z.infer<typeof signerCheckSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Response Types
// ═══════════════════════════════════════════════════════════════════════════

export type {
  CustodyConfigResponse,
  CustodyConfigsResponse,
  CustodyWalletAggregateResponse,
  CustodyWalletByIdResponse,
  CustodyWalletResponse,
  CustodyWalletsResponse,
  DeleteWalletResponse,
  InitializeSigningResponse,
  SignerCheckResponse,
  SwitchProviderOptionsResponse,
};
