/**
 * Keychain Privy Adapter
 *
 * Wraps @solana/keychain-privy PrivySigner to implement SigningPort.
 * Privy provides hosted wallet custody via the Privy Wallet API.
 */

import { PrivySigner } from "@solana/keychain-privy";
import type { Address } from "@solana/kit";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainPrivyConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainPrivyAdapter extends BaseKeychainAdapter {
  readonly providerId = "privy";

  private readonly config: KeychainPrivyConfig;
  private readonly signerByWalletId = new Map<string, Promise<PrivySigner>>();

  constructor(config: KeychainPrivyConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the underlying PrivySigner for direct use with @solana/kit.
   */
  async getTransactionSigner(walletId?: string, _walletPublicKey?: Address): Promise<PrivySigner> {
    return this.getPrivySigner(walletId);
  }

  private async getPrivySigner(walletId?: string): Promise<PrivySigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new Error("Privy wallet ID is required");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = PrivySigner.create({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      walletId: denormalizePrivyWalletId(normalizedWalletId),
      apiBaseUrl: this.config.apiBaseUrl,
      requestDelayMs: this.config.requestDelayMs,
    });
    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}

function denormalizePrivyWalletId(walletId: string): string {
  return walletId.startsWith("privy_") ? walletId.slice("privy_".length) : walletId;
}
