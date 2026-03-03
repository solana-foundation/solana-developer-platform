/**
 * Keychain Coinbase CDP Adapter
 *
 * Wraps @sdp/keychain-coinbase CoinbaseCdpSigner to implement SigningPort.
 * Coinbase CDP provides hosted Solana wallets via CDP v2 APIs.
 */

import type { SignRequest, SignResult } from "@/services/ports";
import { CoinbaseCdpSigner } from "@sdp/keychain-coinbase";
import type { SolanaSigner } from "@solana/keychain-core";
import type { Address } from "@solana/kit";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainCoinbaseConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainCoinbaseAdapter extends BaseKeychainAdapter {
  readonly providerId = "coinbase_cdp";

  protected signer!: SolanaSigner;

  private readonly config: KeychainCoinbaseConfig;
  private readonly signerByWalletId = new Map<string, Promise<CoinbaseCdpSigner>>();

  constructor(config: KeychainCoinbaseConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the underlying Coinbase signer for direct use with @solana/kit.
   */
  async getTransactionSigner(
    walletId?: string,
    _walletPublicKey?: Address
  ): Promise<CoinbaseCdpSigner> {
    return this.getCoinbaseSigner(walletId);
  }

  /**
   * Coinbase signing is synchronous from the API perspective.
   */
  requiresApproval(): boolean {
    return false;
  }

  /**
   * Get the public key, ensuring initialization first.
   */
  async getPublicKey(walletId?: string): Promise<Address> {
    const signer = await this.getCoinbaseSigner(walletId);
    return signer.address as Address;
  }

  /**
   * SigningPort does not specify a wallet ID; for Coinbase CDP, we sign with the
   * configured default wallet.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    const signer = await this.getCoinbaseSigner();
    this.signer = signer as unknown as SolanaSigner;
    return super.sign(request);
  }

  private async getCoinbaseSigner(walletId?: string): Promise<CoinbaseCdpSigner> {
    const normalizedWalletId = walletId ?? this.config.defaultWalletId;
    if (!normalizedWalletId) {
      throw new Error("Coinbase CDP wallet ID is required");
    }

    const cacheKey = normalizedWalletId;
    const existing = this.signerByWalletId.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = CoinbaseCdpSigner.create({
      apiKeyId: this.config.apiKeyId,
      apiKeySecret: this.config.apiKeySecret,
      walletSecret: this.config.walletSecret,
      walletId: denormalizeCoinbaseWalletId(normalizedWalletId),
      apiBaseUrl: this.config.apiBaseUrl,
      requestDelayMs: this.config.requestDelayMs,
    });
    this.signerByWalletId.set(cacheKey, created);
    return created;
  }
}

function denormalizeCoinbaseWalletId(walletId: string): string {
  return walletId.startsWith("cdp_") ? walletId.slice("cdp_".length) : walletId;
}
