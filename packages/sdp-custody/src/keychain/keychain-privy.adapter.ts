/**
 * Keychain Privy Adapter
 *
 * Wraps @solana/keychain-privy PrivySigner to implement SigningPort.
 * Privy provides hosted wallet custody via the Privy Wallet API.
 */

import type { SolanaSigner } from "@solana/keychain-core";
import { PrivySigner } from "@solana/keychain-privy";
import type { Address } from "@solana/kit";
import type { SignRequest, SignResult } from "../signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainPrivyConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainPrivyAdapter extends BaseKeychainAdapter {
  readonly providerId = "privy";

  protected signer!: SolanaSigner;

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

  /**
   * Privy signing is synchronous from the API perspective.
   */
  requiresApproval(): boolean {
    return false;
  }

  /**
   * Get the public key, ensuring initialization first.
   */
  async getPublicKey(walletId?: string): Promise<Address> {
    const signer = await this.getPrivySigner(walletId);
    return signer.address as Address;
  }

  /**
   * SigningPort does not specify a wallet ID; for Privy, we always sign with the
   * configured default wallet.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    const signer = await this.getPrivySigner();
    this.signer = signer as unknown as SolanaSigner;
    return super.sign(request);
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
