/**
 * Keychain Para Adapter
 *
 * Wraps @solana/keychain-para ParaSigner to implement SigningPort.
 * Para provides hosted wallets via the Para REST API.
 */

import { ParaSigner } from "@solana/keychain-para";
import type { Address } from "@solana/kit";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainParaConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainParaAdapter extends BaseKeychainAdapter {
  readonly providerId = "para";

  private readonly config: KeychainParaConfig;
  private readonly signerByWalletId = new Map<string, Promise<ParaSigner>>();

  constructor(config: KeychainParaConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the underlying Para signer for direct use with @solana/kit.
   */
  async getTransactionSigner(walletId?: string, _walletPublicKey?: Address): Promise<ParaSigner> {
    return this.getParaSigner(walletId);
  }

  private async getParaSigner(walletId?: string): Promise<ParaSigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new Error("Para wallet ID is required");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = ParaSigner.create({
      apiKey: this.config.apiKey,
      apiBaseUrl: this.config.apiBaseUrl,
      requestDelayMs: this.config.requestDelayMs,
      walletId: denormalizeParaWalletId(normalizedWalletId),
    });
    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}

function denormalizeParaWalletId(walletId: string): string {
  return walletId.startsWith("para_") ? walletId.slice("para_".length) : walletId;
}
