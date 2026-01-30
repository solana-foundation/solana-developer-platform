/**
 * Custody API Schemas
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

export const initializeSigningSchema = z.discriminatedUnion("provider", [
  initializeLocalSchema,
  initializeFireblocksSchema,
]);

export type InitializeSigningRequest = z.infer<typeof initializeSigningSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Response Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CustodyConfigResponse {
  config: {
    id: string;
    organizationId: string;
    projectId: string | null;
    provider: "local" | "fireblocks";
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

export interface InitializeSigningResponse {
  configId: string;
  publicKey: string;
  walletId: string;
}
