/**
 * Base Keychain Adapter
 *
 * Abstract base class for adapters that wrap @solana/keychain signers.
 * Handles the conversion between our SigningPort interface and Keychain's SolanaSigner.
 *
 * Key conversions:
 * - SignRequest.message (Uint8Array) → SignableMessage for Keychain
 * - SignatureDictionary (Record<Address, SignatureBytes>) → Map<Address, Uint8Array> for SignResult
 */

import type { SolanaSigner } from "@solana/keychain-core";
import type { Address, TransactionSigner } from "@solana/kit";
import { createSignableMessage } from "@solana/signers";
import type {
  FullSigningPort,
  GeneratedKeypair,
  SignRequest,
  SignResult,
  SignStatus,
} from "@/services/ports";
import { SigningError } from "@/services/ports";

// ═══════════════════════════════════════════════════════════════════════════
// Base Adapter
// ═══════════════════════════════════════════════════════════════════════════

export abstract class BaseKeychainAdapter implements FullSigningPort {
  /** Provider identifier (e.g., "keychain-fireblocks") */
  abstract readonly providerId: string;

  /** The underlying Keychain signer */
  protected abstract signer: SolanaSigner;

  /**
   * Get an @solana/kit-compatible transaction signer.
   * Implementations may ignore wallet-level args when single-wallet.
   */
  abstract getTransactionSigner(
    walletId?: string,
    walletPublicKey?: Address
  ): Promise<TransactionSigner>;

  /**
   * Whether this provider requires async approval workflows.
   * Override in subclasses that have approval requirements.
   */
  requiresApproval(): boolean {
    return false;
  }

  /**
   * Get the public key for the signing wallet.
   * Keychain signers only support a single address.
   */
  async getPublicKey(_walletId?: string): Promise<Address> {
    return this.signer.address as Address;
  }

  /**
   * Sign a transaction message using the Keychain signer.
   *
   * Converts our SignRequest to Keychain's SignableMessage format,
   * then converts the SignatureDictionary result back to our Map format.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    try {
      // Check signer availability
      const isAvailable = await this.signer.isAvailable();
      if (!isAvailable) {
        return {
          status: "failed",
          error: `${this.providerId} signer not available`,
        };
      }

      // Create a SignableMessage from our raw bytes
      const signableMessage = createSignableMessage(request.message);

      // Sign using Keychain's signMessages method
      const [signatureDict] = await this.signer.signMessages([signableMessage]);

      // Convert SignatureDictionary to our Map<Address, Uint8Array> format
      const signatures = new Map<Address, Uint8Array>();
      for (const [addr, sig] of Object.entries(signatureDict)) {
        // SignatureBytes is a branded Uint8Array, so this conversion is safe
        signatures.set(addr as Address, sig as Uint8Array);
      }

      return {
        status: "completed",
        signatures,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown signing error";
      return {
        status: "failed",
        error: `${this.providerId}: ${message}`,
      };
    }
  }

  /**
   * Poll for async signing status.
   * Not supported by base Keychain adapters since they complete synchronously.
   * Override in subclasses that have async approval workflows.
   */
  getSignStatus(_requestId: string): Promise<SignStatus> {
    throw new SigningError(
      `${this.providerId}: async status polling not supported`,
      "INVALID_REQUEST"
    );
  }

  /**
   * Generate a new keypair in custody.
   * Not supported by hosted Keychain signers - they work with pre-existing keys.
   * KeychainMemoryAdapter overrides this to support ephemeral keypair generation
   * (used for mint account creation in local/self-hosted deployments).
   */
  generateKeypair(): Promise<GeneratedKeypair> {
    throw new SigningError(
      `${this.providerId}: keypair generation not supported. Use KeychainMemoryAdapter for ephemeral keys.`,
      "INVALID_REQUEST"
    );
  }
}
