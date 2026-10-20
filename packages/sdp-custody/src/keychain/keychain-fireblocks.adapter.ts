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

import { FireblocksSigner } from "@solana/keychain-fireblocks";
import type { Address } from "@solana/kit";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainFireblocksConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainFireblocksAdapter extends BaseKeychainAdapter {
  readonly providerId = "fireblocks";

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
      // RAW returns a signature; SDP owns fee sponsorship and broadcast.
      useProgramCall: false,
    });
    await signer.init();
    return signer;
  }
}

function denormalizeFireblocksWalletId(walletId: string): string {
  return walletId.startsWith("fb_") ? walletId.slice("fb_".length) : walletId;
}
