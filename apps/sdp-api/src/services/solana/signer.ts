/**
 * Solana Signer Service
 *
 * Provides signing capabilities for Solana transactions.
 * Uses signing adapters to support multiple custody providers:
 * - local: Uses CUSTODY_PRIVATE_KEY (development) or org-specific keys from DB
 * - fireblocks: Uses Fireblocks MPC via @solana/keychain-fireblocks (production)
 * - privy: Uses Privy hosted wallets via @solana/keychain-privy
 * - coinbase_cdp: Uses Coinbase CDP hosted wallets via @solana/keychain-cdp
 * - para: Uses Para hosted wallets via @solana/keychain-para
 * - turnkey: Uses Turnkey hosted wallets via @solana/keychain-turnkey
 *
 * Resolution order for createOrgSigner:
 * 1. Project-specific config (if projectId provided)
 * 2. Organization-level config
 */

import { getBase58Codec } from "@solana/codecs";
import {
  type Address,
  createKeyPairSignerFromBytes,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { createSigningAdapterFromEnv } from "@/services/adapters";
import { createSigningService } from "@/services/domain/signing.service";
import { isFullSigningPort, SigningError } from "@/services/ports";
import type { Env } from "@/types/env";

const base58 = getBase58Codec();

// Re-export types for consumers
export type { KeyPairSigner, TransactionSigner };

// ═══════════════════════════════════════════════════════════════════════════
// Signer Factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a transaction signer from a Base58-encoded Solana keypair.
 * The keypair should be 64 bytes: 32 byte private + 32 byte public.
 */
export async function createSignerFromBase58(privateKeyBase58: string): Promise<KeyPairSigner> {
  // codec.encode converts base58 string → bytes
  const secretKey = base58.encode(privateKeyBase58);

  // Solana keypair format: 64 bytes = 32 byte private + 32 byte public
  if (secretKey.length !== 64) {
    throw new Error(`Invalid keypair length: expected 64 bytes, got ${secretKey.length}`);
  }

  // Create signer using @solana/kit
  return createKeyPairSignerFromBytes(secretKey);
}

/**
 * Create a transaction signer based on environment configuration.
 *
 * Resolves the signing provider from SIGNING_PROVIDER env var:
 * - "local" (default): Uses CUSTODY_PRIVATE_KEY via KeychainMemoryAdapter
 * - "fireblocks": Uses Fireblocks via KeychainFireblocksAdapter
 * - "privy": Uses Privy via KeychainPrivyAdapter
 * - "coinbase_cdp": Uses Coinbase CDP via KeychainCoinbaseAdapter
 * - "para": Uses Para via KeychainParaAdapter
 * - "turnkey": Uses Turnkey via KeychainTurnkeyAdapter
 * - "dfns": Uses DFNS via KeychainDfnsAdapter
 * - "anchorage": Not supported for signing (wallet lifecycle only)
 *
 * The returned signer is compatible with @solana/kit signing utilities:
 * - signTransactionMessageWithSigners()
 * - partiallySignTransactionMessageWithSigners()
 * - addSignersToTransactionMessage()
 *
 * @deprecated Use createOrgSigner() for org-aware signing
 */
export async function createSigner(env: Env): Promise<TransactionSigner> {
  const adapter = await createSigningAdapterFromEnv(env);

  if (!isFullSigningPort(adapter)) {
    throw new SigningError(
      `Provider does not support transaction signing: ${adapter.providerId}`,
      "INVALID_REQUEST"
    );
  }

  return adapter.getTransactionSigner();
}

/**
 * Create a transaction signer for an organization with scope default resolution.
 *
 * Resolution order:
 * 1. Project default config (if projectId provided)
 * 2. Organization default config
 *
 * This is the recommended signer factory for production use. It enables
 * per-organization signing keys with explicit DB-backed provider selection.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param orgId - Organization ID from auth context
 * @param projectId - Optional project ID for project-specific signing keys
 * @returns TransactionSigner compatible with @solana/kit
 */
export async function createOrgSigner(
  env: Env,
  orgId: string,
  projectId?: string | null,
  walletId?: string | null
): Promise<TransactionSigner> {
  const signingService = createSigningService(env);
  return signingService.getTransactionSigner(orgId, projectId ?? undefined, walletId ?? undefined);
}

/**
 * Create a KeyPairSigner specifically (only works with local provider).
 * Use createSigner() for provider-agnostic code.
 *
 * @deprecated Use createSigner() instead for provider flexibility
 */
export async function createLocalSigner(env: Env): Promise<KeyPairSigner> {
  const privateKey = env.CUSTODY_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("CUSTODY_PRIVATE_KEY environment variable is not configured");
  }

  return createSignerFromBase58(privateKey);
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a signer controls a specific address
 */
export function signerControlsAddress(signer: KeyPairSigner, address: Address): boolean {
  return signer.address === address;
}

/**
 * Get the address from a signer
 */
export function getSignerAddress(signer: KeyPairSigner): Address {
  return signer.address;
}
