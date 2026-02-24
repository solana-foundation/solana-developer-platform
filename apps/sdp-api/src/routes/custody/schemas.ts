/**
 * Wallet API Schemas
 */

import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Initialize Signing
// ═══════════════════════════════════════════════════════════════════════════

export const initializeLocalSchema = z.object({
  provider: z.literal("local"),
  projectId: z.string().optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeFireblocksSchema = z.object({
  provider: z.literal("fireblocks"),
  projectId: z.string().optional(),
  apiKey: z.string().min(1),
  apiSecretPem: z.string().min(1),
  vaultAccountId: z.string().min(1),
  assetId: z.string().default("SOL"),
  apiBaseUrl: z.string().url().optional(),
});

export const initializePrivySchema = z.object({
  provider: z.literal("privy"),
  projectId: z.string().optional(),
  apiBaseUrl: z.string().url().optional(),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeCoinbaseCdpSchema = z.object({
  provider: z.literal("coinbase_cdp"),
  projectId: z.string().optional(),
  apiBaseUrl: z.string().url().optional(),
  network: z.enum(["solana", "solana-devnet"]).optional(),
  walletAddress: z.string().min(32).max(44).optional(),
  accountPolicy: z
    .string()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
    .optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeAnchorageSchema = z.object({
  provider: z.literal("anchorage"),
  projectId: z.string().optional(),
  apiBaseUrl: z.string().url().optional(),
  vaultId: z.string().min(1).optional(),
  networkId: z.string().min(1).optional(),
  subaccountId: z.string().min(1).optional(),
  walletId: z.string().min(1).optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeParaSchema = z.object({
  provider: z.literal("para"),
  projectId: z.string().optional(),
  apiBaseUrl: z.string().url().optional(),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletId: z.string().min(1).optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeTurnkeySchema = z.object({
  provider: z.literal("turnkey"),
  projectId: z.string().optional(),
  apiBaseUrl: z.string().url().optional(),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  privateKeyId: z.string().min(1).optional(),
  walletLabel: z.string().max(100).optional(),
});

export const initializeSigningSchema = z.discriminatedUnion("provider", [
  initializeLocalSchema,
  initializeFireblocksSchema,
  initializePrivySchema,
  initializeCoinbaseCdpSchema,
  initializeAnchorageSchema,
  initializeParaSchema,
  initializeTurnkeySchema,
]);

export type InitializeSigningRequest = z.infer<typeof initializeSigningSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Create Wallet
// ═══════════════════════════════════════════════════════════════════════════

export const createWalletSchema = z.object({
  projectId: z.string().optional(),
  label: z.string().max(100).optional(),
  purpose: z
    .enum(["root", "mint_authority", "freeze_authority", "fee_payer", "transfer"])
    .optional(),
  setDefault: z.boolean().optional(),
});

export type CreateWalletRequest = z.infer<typeof createWalletSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Switch Signing Provider
// ═══════════════════════════════════════════════════════════════════════════

// For now, switching uses the same shape as initialize. The handler deactivates the
// existing config for the scope (org or project) and then runs the initializer.
export const switchSigningSchema = initializeSigningSchema;

export type SwitchSigningRequest = z.infer<typeof switchSigningSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Set Default Wallet
// ═══════════════════════════════════════════════════════════════════════════

export const setDefaultWalletSchema = z.object({
  projectId: z.string().optional(),
  walletId: z.string().min(1),
});

export type SetDefaultWalletRequest = z.infer<typeof setDefaultWalletSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Signer Check (API key flow)
// ═══════════════════════════════════════════════════════════════════════════

export const signerCheckSchema = z.object({
  memo: z.string().max(256).optional(),
});

export type SignerCheckRequest = z.infer<typeof signerCheckSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Response Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CustodyConfigResponse {
  config: {
    id: string;
    organizationId: string;
    projectId: string | null;
    provider:
      | "local"
      | "fireblocks"
      | "privy"
      | "coinbase_cdp"
      | "anchorage"
      | "para"
      | "turnkey";
    publicKey: string;
    defaultWalletId: string | null;
    status: "active" | "inactive";
    createdAt: string;
  };
}

export interface CustodyWalletResponse {
  wallet: {
    id: string;
    walletId: string;
    publicKey: string;
    label: string | null;
    purpose: string | null;
    status: "active" | "inactive";
    createdAt: string;
  };
}

export interface CustodyWalletsResponse {
  wallets: CustodyWalletResponse["wallet"][];
}

export interface SwitchProviderOptionsResponse {
  providers: Array<{
    provider: "privy" | "coinbase_cdp" | "anchorage" | "para" | "turnkey" | "local";
    hasReusableWallet: boolean;
    needsWalletLabel: boolean;
  }>;
}

export interface InitializeSigningResponse {
  configId: string;
  publicKey: string;
  walletId: string;
}

export interface SignerCheckResponse {
  walletId: string;
  walletAddress: string;
  feePayer: string;
  memo: string;
  signature: string;
  slot: number;
  blockTime: string;
}
