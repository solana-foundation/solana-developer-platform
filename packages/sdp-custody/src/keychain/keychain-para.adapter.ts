/**
 * Keychain Para Adapter
 *
 * Wraps @solana/keychain-para ParaSigner to implement SigningPort.
 * Para provides hosted wallets via the Para REST API.
 */

import type { SolanaSigner } from "@solana/keychain-core";
import { ParaSigner } from "@solana/keychain-para";
import type { Address } from "@solana/kit";
import type { SignRequest, SignResult } from "../signing";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainParaConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainParaAdapter extends BaseKeychainAdapter {
  readonly providerId = "para";

  protected signer!: SolanaSigner;

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

  /**
   * Para signing is synchronous from the API perspective.
   */
  requiresApproval(): boolean {
    return false;
  }

  /**
   * Get the public key, ensuring initialization first.
   */
  async getPublicKey(walletId?: string): Promise<Address> {
    const signer = await this.getParaSigner(walletId);
    return signer.address as Address;
  }

  /**
   * SigningPort does not specify a wallet ID; for Para, we sign with the
   * configured default wallet.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    const signer = await this.getParaSigner();
    this.signer = signer as unknown as SolanaSigner;
    return super.sign(request);
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
