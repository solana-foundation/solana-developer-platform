/**
 * Keychain Fireblocks Adapter
 *
 * Wraps @solana/keychain-fireblocks FireblocksSigner to implement SigningPort.
 * Fireblocks provides enterprise-grade MPC custody with approval workflows.
 *
 * The Keychain FireblocksSigner handles:
 * - JWT authentication with Fireblocks API
 * - RAW signing operation
 * - Polling for transaction completion
 */

import type { SolanaSigner } from "@solana/keychain-core";
import { FireblocksSigner } from "@solana/keychain-fireblocks";
import type { Address } from "@solana/kit";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainFireblocksConfig } from "./types";

type FireblocksSignerDebugHooks = {
  __sdpDebugPatched__?: boolean;
  request?: <T>(method: string, uri: string, body?: unknown) => Promise<T>;
};

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainFireblocksAdapter extends BaseKeychainAdapter {
  readonly providerId = "fireblocks";

  protected signer: SolanaSigner;
  private fireblocksSigner: FireblocksSigner;
  private initialized = false;

  constructor(config: KeychainFireblocksConfig) {
    super();

    this.fireblocksSigner = new FireblocksSigner({
      apiKey: config.apiKey,
      privateKeyPem: config.apiSecretPem,
      vaultAccountId: config.vaultAccountId,
      assetId: config.assetId ?? "SOL",
      apiBaseUrl: config.apiBaseUrl,
      pollIntervalMs: config.pollIntervalMs,
      maxPollAttempts: config.maxPollAttempts,
      requestDelayMs: config.requestDelayMs,
      // Always use RAW signing - we handle broadcast separately via Kora
      useProgramCall: false,
    });
    this.attachDebugLogging();

    // Cast to SolanaSigner interface
    this.signer = this.fireblocksSigner as unknown as SolanaSigner;
  }

  /**
   * Get the underlying FireblocksSigner for direct use with @solana/kit.
   * The FireblocksSigner implements SolanaSigner which extends TransactionPartialSigner,
   * making it compatible with signTransactionMessageWithSigners and other kit utilities.
   */
  async getTransactionSigner(
    _walletId?: string,
    _walletPublicKey?: Address
  ): Promise<FireblocksSigner> {
    await this.ensureInitialized();
    return this.fireblocksSigner;
  }

  /**
   * Initialize the Fireblocks signer.
   * Must be called before any signing operations to fetch the public key.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.fireblocksSigner.init();
    this.initialized = true;
  }

  /**
   * Fireblocks may have approval workflows in enterprise setups.
   * However, the Keychain signer polls until completion internally,
   * so from our API's perspective it appears synchronous.
   */
  requiresApproval(): boolean {
    // Return false since Keychain handles polling internally
    // If we need external polling, we'd need to implement a custom flow
    return false;
  }

  /**
   * Get the public key, ensuring initialization first.
   */
  async getPublicKey(_walletId?: string): Promise<Address> {
    await this.ensureInitialized();
    return this.signer.address as Address;
  }

  /**
   * Ensure the signer is initialized before operations.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private attachDebugLogging(): void {
    const signer = this.fireblocksSigner as unknown as FireblocksSignerDebugHooks;

    if (signer.__sdpDebugPatched__ || typeof signer.request !== "function") {
      return;
    }

    const originalRequest = signer.request.bind(this.fireblocksSigner) as <T>(
      method: string,
      uri: string,
      body?: unknown
    ) => Promise<T>;

    signer.request = (async <T>(method: string, uri: string, body?: unknown): Promise<T> => {
      try {
        console.info("sdp_fireblocks_api_request", {
          method,
          uri,
          body,
        });

        const response = await originalRequest<T>(method, uri, body);

        console.info("sdp_fireblocks_api_response", {
          method,
          uri,
          body,
          response,
        });

        return response;
      } catch (error) {
        console.error("sdp_fireblocks_api_error", {
          method,
          uri,
          body,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                }
              : String(error),
        });
        throw error;
      }
    }) as typeof signer.request;

    signer.__sdpDebugPatched__ = true;
  }
}
