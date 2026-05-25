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
import type { SignRequest, SignResult } from "@/services/ports";
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

  protected signer!: SolanaSigner;
  private readonly config: KeychainFireblocksConfig;
  private readonly signerByVaultAccountId = new Map<string, Promise<FireblocksSigner>>();

  constructor(config: KeychainFireblocksConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the underlying FireblocksSigner for direct use with @solana/kit.
   * The FireblocksSigner implements SolanaSigner which extends TransactionPartialSigner,
   * making it compatible with signTransactionMessageWithSigners and other kit utilities.
   */
  async getTransactionSigner(
    walletId?: string,
    _walletPublicKey?: Address
  ): Promise<FireblocksSigner> {
    return this.getFireblocksSigner(walletId);
  }

  /**
   * Initialize the Fireblocks signer.
   * Must be called before any signing operations to fetch the public key.
   */
  async init(walletId?: string): Promise<void> {
    await this.getFireblocksSigner(walletId);
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
  async getPublicKey(walletId?: string): Promise<Address> {
    const signer = await this.getFireblocksSigner(walletId);
    return signer.address as Address;
  }

  /**
   * SigningPort does not specify a wallet ID; for Fireblocks, sign with the
   * configured default vault.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    const signer = await this.getFireblocksSigner();
    this.signer = signer as unknown as SolanaSigner;
    return super.sign(request);
  }

  private getFireblocksSigner(walletId?: string): Promise<FireblocksSigner> {
    const vaultAccountId = walletId
      ? denormalizeFireblocksWalletId(walletId)
      : this.config.vaultAccountId;
    const existing = this.signerByVaultAccountId.get(vaultAccountId);
    if (existing) {
      return existing;
    }

    const created = this.createInitializedSigner(vaultAccountId).catch((error: unknown) => {
      if (this.signerByVaultAccountId.get(vaultAccountId) === created) {
        this.signerByVaultAccountId.delete(vaultAccountId);
      }
      throw error;
    });
    this.signerByVaultAccountId.set(vaultAccountId, created);
    return created;
  }

  private async createInitializedSigner(vaultAccountId: string): Promise<FireblocksSigner> {
    const signer = new FireblocksSigner({
      apiKey: this.config.apiKey,
      privateKeyPem: this.config.apiSecretPem,
      vaultAccountId,
      assetId: this.config.assetId ?? "SOL",
      apiBaseUrl: this.config.apiBaseUrl,
      pollIntervalMs: this.config.pollIntervalMs,
      maxPollAttempts: this.config.maxPollAttempts,
      requestDelayMs: this.config.requestDelayMs,
      // Always use RAW signing - we handle broadcast separately via Kora
      useProgramCall: false,
    });
    this.attachDebugLogging(signer);
    await signer.init();
    return signer;
  }

  private attachDebugLogging(fireblocksSigner: FireblocksSigner): void {
    const signer = fireblocksSigner as unknown as FireblocksSignerDebugHooks;

    if (signer.__sdpDebugPatched__ || typeof signer.request !== "function") {
      return;
    }

    const originalRequest = signer.request.bind(fireblocksSigner) as <T>(
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

function denormalizeFireblocksWalletId(walletId: string): string {
  return walletId.startsWith("fb_") ? walletId.slice("fb_".length) : walletId;
}
