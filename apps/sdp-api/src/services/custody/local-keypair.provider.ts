/**
 * Local Keypair Custody Provider
 *
 * Synchronous signing using a keypair loaded from environment variables.
 * This is the default provider for development and simple deployments
 * where keys are managed directly in the SDP infrastructure.
 *
 * For production enterprise deployments, use an institutional custody
 * provider like Fireblocks, Dfns, or Turnkey.
 */

import { decodeBase58 } from "@/lib/solana";
import type { Env } from "@/types/env";
import {
  type Address,
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
} from "@solana/kit";
import type {
  CustodyProvider,
  GeneratedKeypair,
  SignRequest,
  SignResponse,
  SignatureStatus,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Provider Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class LocalKeypairProvider implements CustodyProvider {
  readonly providerId = "local";

  private env: Env;
  private signer: KeyPairSigner | null = null;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get the public key for the custody wallet.
   * LocalKeypairProvider only supports a single wallet from CUSTODY_PRIVATE_KEY.
   */
  async getPublicKey(_walletId?: string): Promise<Address> {
    const signer = await this.getSigner();
    return signer.address;
  }

  /**
   * Sign a transaction.
   *
   * Note: For LocalKeypairProvider, callers should use getKeypairSigner() and
   * integrate with @solana/kit's signTransactionMessageWithSigners() directly.
   * This method is here to satisfy the CustodyProvider interface but returns
   * a "not supported" response since transaction signing via raw bytes requires
   * additional dependencies.
   *
   * For actual signing, use:
   * - Token2022Service methods (which use getKeypairSigner internally)
   * - Or sign via the custody service's higher-level API
   */
  async sign(_request: SignRequest): Promise<SignResponse> {
    // LocalKeypairProvider doesn't support signing raw transaction bytes
    // through this interface. Use getKeypairSigner() for direct signer access.
    return {
      status: "failed",
      // biome-ignore lint/nursery/noSecrets: This is an error message, not a secret
      error: "LocalKeypairProvider: use getKeypairSigner() instead of sign()",
    };
  }

  /**
   * Local keypair provider does not require approval - signing is synchronous.
   */
  requiresApproval(): boolean {
    return false;
  }

  /**
   * Not implemented for local provider - signing is always synchronous.
   */
  getSignatureStatus(_requestId: string): Promise<SignatureStatus> {
    // biome-ignore lint/nursery/noSecrets: This is an error message, not a secret
    throw new Error("LocalKeypairProvider: async signing not supported");
  }

  /**
   * Generate a new keypair for mint account creation.
   * Note: This keypair is ephemeral and only used during transaction building.
   * The mint account itself becomes the permanent address.
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
   * This is the primary way to use LocalKeypairProvider - it provides the
   * signer for integration with @solana/kit's transaction signing functions.
   */
  async getKeypairSigner(): Promise<KeyPairSigner> {
    return this.getSigner();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═════════════════════════════════════════════════════════════════════════

  private async getSigner(): Promise<KeyPairSigner> {
    if (this.signer) {
      return this.signer;
    }

    const privateKey = this.env.CUSTODY_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("CUSTODY_PRIVATE_KEY environment variable is not configured");
    }

    const secretKey = decodeBase58(privateKey);

    // Solana keypair format: 64 bytes = 32 byte private + 32 byte public
    if (secretKey.length !== 64) {
      throw new Error(`Invalid keypair length: expected 64 bytes, got ${secretKey.length}`);
    }

    this.signer = await createKeyPairSignerFromBytes(secretKey);
    return this.signer;
  }
}
