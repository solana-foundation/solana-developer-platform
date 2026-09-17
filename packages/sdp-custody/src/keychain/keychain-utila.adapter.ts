/**
 * Keychain Utila Adapter
 *
 * Wraps @solana/keychain-utila to implement SigningPort.
 * Utila provides transaction signing for existing Solana wallets in Utila vaults.
 */

import type { SolanaSigner } from "@solana/keychain-core";
import { createUtilaSigner } from "@solana/keychain-utila";
import type { Address, TransactionSigner } from "@solana/kit";
import { denormalizeUtilaWalletId } from "../provider-wallet-ids";
import { SigningError } from "../signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainUtilaConfig } from "./types";

export class KeychainUtilaAdapter extends BaseKeychainAdapter {
  readonly providerId = "utila";

  private readonly config: KeychainUtilaConfig;
  private readonly signerByWalletId = new Map<string, Promise<SolanaSigner>>();

  constructor(config: KeychainUtilaConfig) {
    super();
    this.config = config;
  }

  async getTransactionSigner(
    walletId?: string,
    _walletPublicKey?: Address
  ): Promise<TransactionSigner> {
    return this.getUtilaSigner(walletId);
  }

  private getUtilaSigner(walletId?: string): Promise<SolanaSigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new SigningError("Utila wallet ID is required", "PROVIDER_NOT_CONFIGURED");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = createUtilaSigner({
      serviceAccountEmail: this.config.serviceAccountEmail,
      serviceAccountPrivateKeyPem: this.config.serviceAccountPrivateKeyPem,
      vaultId: this.config.vaultId,
      walletId: denormalizeUtilaWalletId(normalizedWalletId),
      network: this.config.network,
      apiBaseUrl: this.config.apiBaseUrl,
      pollIntervalMs: this.config.pollIntervalMs,
      maxPollAttempts: this.config.maxPollAttempts,
      designatedSigners: this.config.designatedSigners,
    }).catch((error: unknown) => {
      if (this.signerByWalletId.get(cacheKey) === created) {
        this.signerByWalletId.delete(cacheKey);
      }
      throw error;
    });

    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}
