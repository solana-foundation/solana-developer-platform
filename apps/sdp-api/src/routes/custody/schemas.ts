/**
 * Wallet API Schemas
 */

import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import { z } from "zod";

const custodyProviderSchema = z.enum(CUSTODY_PROVIDERS);

// Provider API endpoints are deployment configuration, not tenant input.
// Keep initialize payloads limited to wallet-scoped choices.

// ═══════════════════════════════════════════════════════════════════════════
// Initialize Signing
// ═══════════════════════════════════════════════════════════════════════════

const initializeLocalSchema = z.strictObject({
  provider: z.literal("local"),
  walletLabel: z.string().max(100).optional(),
});

const initializeFireblocksSchema = z.strictObject({
  provider: z.literal("fireblocks"),
  walletLabel: z.string().max(100).optional(),
});

const initializePrivySchema = z.strictObject({
  provider: z.literal("privy"),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletLabel: z.string().max(100).optional(),
});

const initializeCoinbaseCdpSchema = z.strictObject({
  provider: z.literal("coinbase_cdp"),
  network: z.enum(["solana", "solana-devnet"]).optional(),
  accountPolicy: z
    .string()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
    .optional(),
  walletLabel: z.string().max(100).optional(),
});

const initializeParaSchema = z.strictObject({
  provider: z.literal("para"),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletLabel: z.string().max(100).optional(),
});

const initializeTurnkeySchema = z.strictObject({
  provider: z.literal("turnkey"),
  requestDelayMs: z.number().int().min(0).max(3000).optional(),
  walletLabel: z.string().max(100).optional(),
});

const initializeDfnsSchema = z.strictObject({
  provider: z.literal("dfns"),
  network: z.enum(["Solana", "SolanaDevnet"]).optional(),
  walletLabel: z.string().max(100).optional(),
});

const initializeIbmHavenSchema = z.strictObject({
  provider: z.literal("ibm_haven"),
  network: z.enum(["Solana", "SolanaDevnet"]).optional(),
  walletLabel: z.string().max(100).optional(),
});

const initializeAnchorageSchema = z.strictObject({
  provider: z.literal("anchorage"),
  walletLabel: z.string().max(100).optional(),
  network: z.enum(["solana", "solana-devnet"]).optional(),
});

// Utila is platform-managed (single configured vault); connecting only needs an
// optional label for the first wallet, like the other hosted providers.
const initializeUtilaSchema = z.strictObject({
  provider: z.literal("utila"),
  walletLabel: z.string().max(100).optional(),
});

export const initializeSigningSchema = z.discriminatedUnion("provider", [
  initializeLocalSchema,
  initializeFireblocksSchema,
  initializePrivySchema,
  initializeCoinbaseCdpSchema,
  initializeParaSchema,
  initializeTurnkeySchema,
  initializeDfnsSchema,
  initializeIbmHavenSchema,
  initializeAnchorageSchema,
  initializeUtilaSchema,
]);

export type InitializeSigningRequest = z.infer<typeof initializeSigningSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Create Wallet
// ═══════════════════════════════════════════════════════════════════════════

// A wallet lives under exactly one provider account: the provider's Managed
// config (a project holds one per provider) or a BYOK connection. Each variant
// forbids the other's key, so a body naming both, or neither, matches no variant.
export const managedWalletOwnerSchema = z.object({
  provider: custodyProviderSchema,
  connectionId: z.never().optional(),
});

export const connectionWalletOwnerSchema = z.object({
  connectionId: z.string().min(1),
  provider: z.never().optional(),
});

const CUSTODY_WALLET_OWNER_ERROR =
  "Name exactly one of provider (Managed) or connectionId (BYOK); custody defaults were removed";

const walletCreationFields = {
  label: z.string().max(100).optional(),
  purpose: z
    .enum(["transfer", "mint_authority", "freeze_authority", "fee_payer"])
    .default("transfer"),
};

export const createManagedWalletSchema = managedWalletOwnerSchema.extend(walletCreationFields);

const createConnectionWalletSchema = connectionWalletOwnerSchema.extend(walletCreationFields);

export const createWalletSchema = z.union(
  [createManagedWalletSchema, createConnectionWalletSchema],
  { error: CUSTODY_WALLET_OWNER_ERROR }
);

export const updateWalletSchema = z.object({
  label: z.string().max(100).nullable().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Delete Wallet
// ═══════════════════════════════════════════════════════════════════════════

export const deleteWalletSchema = z.object({
  provider: custodyProviderSchema.optional(),
  walletId: z.string().min(1),
});

// ═══════════════════════════════════════════════════════════════════════════
// Signer Check
// ═══════════════════════════════════════════════════════════════════════════

export const signerCheckSchema = z.object({
  walletId: z.string().trim().min(1),
});

// ═══════════════════════════════════════════════════════════════════════════
// Devnet Faucet
// ═══════════════════════════════════════════════════════════════════════════

export const walletIdParamsSchema = z.object({
  walletId: z.string().trim().min(1),
});

// The amount is the server's: a body naming one is refused.
export const walletFaucetSchema = z.object({}).strict();
