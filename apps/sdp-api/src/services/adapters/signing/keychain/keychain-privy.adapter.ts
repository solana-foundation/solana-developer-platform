/**
 * Keychain Privy Adapter
 *
 * Wraps @solana/keychain-privy PrivySigner to implement SigningPort.
 * Privy provides hosted wallet custody via the Privy Wallet API.
 */

import type { SignRequest, SignResult } from "@/services/ports";
import type { SolanaSigner } from "@solana/keychain-core";
import { PrivySigner } from "@solana/keychain-privy";
import type { Address } from "@solana/kit";
import { BaseKeychainAdapter } from "./base-keychain.adapter";
import type { KeychainPrivyConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class KeychainPrivyAdapter extends BaseKeychainAdapter {
  readonly providerId = "privy";

  protected signer!: SolanaSigner;
  private privySigner: PrivySigner | null = null;
  private initialized = false;
  private readonly config: KeychainPrivyConfig;

  constructor(config: KeychainPrivyConfig) {
    super();
    this.config = config;
  }

  /**
   * Get the underlying PrivySigner for direct use with @solana/kit.
   */
  async getTransactionSigner(): Promise<PrivySigner> {
    await this.ensureInitialized();
    return this.privySigner as PrivySigner;
  }

  /**
   * Initialize the Privy signer.
   * Must be called before any signing operations to fetch the public key.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.privySigner = await PrivySigner.create({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      walletId: this.config.walletId,
      apiBaseUrl: this.config.apiBaseUrl,
      requestDelayMs: this.config.requestDelayMs,
    });

    this.signer = this.privySigner as unknown as SolanaSigner;
    this.initialized = true;
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
  async getPublicKey(_walletId?: string): Promise<Address> {
    await this.ensureInitialized();
    return this.signer.address as Address;
  }

  /**
   * Ensure the signer is initialized before signing.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    await this.ensureInitialized();
    return super.sign(request);
  }

  /**
   * Ensure the signer is initialized before operations.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }
}
