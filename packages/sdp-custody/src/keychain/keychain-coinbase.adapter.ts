/**
 * Keychain Coinbase CDP Adapter
 *
 * Wraps @solana/keychain-cdp to implement SigningPort.
 * Coinbase CDP provides hosted Solana wallets via CDP v2 APIs.
 */

import { createCdpSigner } from "@solana/keychain-cdp";
import type { SolanaSigner } from "@solana/keychain-core";
import type { Address } from "@solana/kit";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainCoinbaseConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainCoinbaseAdapter extends BaseKeychainAdapter {
  readonly providerId = "coinbase_cdp";

  private readonly config: KeychainCoinbaseConfig;
  private readonly signerByWalletId = new Map<string, Promise<SolanaSigner>>();

  constructor(config: KeychainCoinbaseConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the underlying Coinbase signer for direct use with @solana/kit.
   */
  async getTransactionSigner(walletId?: string, _walletPublicKey?: Address): Promise<SolanaSigner> {
    return this.getCoinbaseSigner(walletId);
  }

  private async getCoinbaseSigner(walletId?: string): Promise<SolanaSigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new Error("Coinbase CDP wallet ID is required");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = createCdpSigner({
      cdpApiKeyId: this.config.apiKeyId,
      cdpApiKeySecret: this.config.apiKeySecret,
      cdpWalletSecret: this.config.walletSecret,
      address: denormalizeCoinbaseWalletId(normalizedWalletId),
      baseUrl: this.config.apiBaseUrl,
      requestDelayMs: this.config.requestDelayMs,
    });
    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}

function denormalizeCoinbaseWalletId(walletId: string): string {
  return walletId.startsWith("cdp_") ? walletId.slice("cdp_".length) : walletId;
}
