/**
 * Local Keypair Signing Adapter
 *
 * Implements SigningPort for local development using a keypair from env vars.
 * Signing is synchronous - no approval workflow required.
 *
 * For production deployments, use KeychainFireblocksAdapter or KeychainAwsKmsAdapter.
 */

import type {
  GeneratedKeypair,
  SignRequest,
  SignResult,
  SignStatus,
  SigningPort,
} from "@/services/ports";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import { getBase58Codec } from "@solana/codecs";
import {
  type Address,
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
} from "@solana/kit";

const base58 = getBase58Codec();

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class LocalKeypairAdapter implements SigningPort {
  readonly providerId = "local";

  private env: Env;
  private signer: KeyPairSigner | null = null;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Local keypair signing is always synchronous - no approval needed
   */
  requiresApproval(): boolean {
    return false;
  }

  /**
   * Get the public key for the custody wallet.
   * LocalKeypairAdapter only supports a single wallet from CUSTODY_PRIVATE_KEY.
   */
  async getPublicKey(_walletId?: string): Promise<Address> {
    const signer = await this.getSigner();
    return signer.address;
  }

  /**
   * Sign a transaction message.
   * Returns immediately since local signing is synchronous.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    try {
      const signer = await this.getSigner();

      // Sign the message bytes using the signer's keyPair private key
      const signature = await crypto.subtle.sign(
        { name: "Ed25519" },
        signer.keyPair.privateKey,
        request.message
      );

      // Create signature map
      const signatures = new Map<Address, Uint8Array>();
      signatures.set(signer.address, new Uint8Array(signature));

      return {
        status: "completed",
        signatures,
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown signing error",
      };
    }
  }

  /**
   * Not implemented for local provider - signing is always synchronous.
   */
  getSignStatus(_requestId: string): Promise<SignStatus> {
    throw new SigningError(
      // biome-ignore lint/nursery/noSecrets: Error message, not a secret
      "LocalKeypairAdapter: async signing not supported, signing is always synchronous",
      "INVALID_REQUEST"
    );
  }

  /**
   * Generate a new ephemeral keypair.
   * Used for mint account creation where the keypair is only needed during
   * transaction building. The mint account itself becomes the permanent address.
   */
  async generateKeypair(): Promise<GeneratedKeypair> {
    const keypair = await generateKeyPairSigner();

    return {
      walletId: keypair.address, // Use address as ID for local provider
      publicKey: keypair.address,
    };
  }

  /**
   * Get the underlying KeyPairSigner for direct use in transaction building.
   * This allows integration with @solana/kit's transaction signing functions.
   */
  async getKeypairSigner(): Promise<KeyPairSigner> {
    return this.getSigner();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private async getSigner(): Promise<KeyPairSigner> {
    if (this.signer) {
      return this.signer;
    }

    const privateKey = this.env.CUSTODY_PRIVATE_KEY;
    if (!privateKey) {
      throw new SigningError(
        "CUSTODY_PRIVATE_KEY environment variable is not configured",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    // codec.decode converts base58 string → bytes
    const secretKey = base58.decode(privateKey);

    // Solana keypair format: 64 bytes = 32 byte private + 32 byte public
    if (secretKey.length !== 64) {
      throw new SigningError(
        `Invalid keypair length: expected 64 bytes, got ${secretKey.length}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    this.signer = await createKeyPairSignerFromBytes(secretKey);
    return this.signer;
  }
}
